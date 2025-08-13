const VERIFICATION_ENDPOINT = process.env.VERIFICATION_ENDPOINT;
const PREMIUM_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Updates the UI to show the premium status by adding a label and styling.
 */
function displayPremiumUI() {
  const titleArea = document.querySelector('h2'); // Target the main h2 title
  if (titleArea) {
    // Prevent adding the label multiple times
    if (titleArea.querySelector('.premium-label')) return;

    titleArea.innerHTML = `
      <div class="title-container">
        ${titleArea.textContent}
        <span class="premium-label">Premium</span>
      </div>
    `;
  }
}

/**
 * Updates the UI to show the user's premium status.
 * In a real app, this would also enable/disable premium features.
 * @param {boolean} isPremium - True if the user has premium access.
 */
function premiumFunction(isPremium) {
  const statusContainer = document.getElementById('premium-status-container');
  if (!statusContainer) return;

  if (isPremium) {
    statusContainer.innerHTML = `
      <p class="status-message status-premium">Status: Premium User</p>
    `;
    // In a real app, you would enable premium UI elements here.
    // Example: document.getElementById('premiumFeatureButton').disabled = false;
  } else {
    statusContainer.innerHTML = `
      <p class="status-message status-free">Status: Not a Premium User</p>
    `;
    // In a real app, you would disable premium UI elements here.
    // Example: document.getElementById('premiumFeatureButton').disabled = true;
  }
}

/**
 * A utility to retry a promise-based function with exponential backoff.
 * @param {Function} fn The async function to retry.
 * @param {number} maxRetries Maximum number of retries.
 * @returns The result of the function if successful.
 */
const retryWithBackoff = async (fn, maxRetries = 3) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        throw error; // Rethrow the last error
      }
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms...`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

/**
 * Checks the user's premium status using a time-based local cache with a graceful fallback.
 * @returns {Promise<boolean>} Resolves to true if the user is premium.
 */
async function getPremiumStatus() {
    // This helper ONLY attempts a silent token fetch.
    const getSilentAuthToken = () => new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (chrome.runtime.lastError || !token) {
                reject(new Error(chrome.runtime.lastError?.message || 'User is not signed in or has not granted consent.'));
            } else {
                // Also get the user's email to return alongside the token
                chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (userInfo) => {
                    if (!userInfo || !userInfo.email) {
                        reject(new Error('Could not retrieve user email for token.'));
                    } else {
                        resolve({ token: token, email: userInfo.email });
                    }
                });
            }
        });
    });

    // 1. Get the current user's identity first. This will throw if they are not signed in.
    const currentUser = await getSilentAuthToken();
    
    // 2. Check for a pending payment (this logic remains).
    const { paymentState } = await chrome.storage.local.get('paymentState');
    const isPaymentPending = paymentState === 'pending';
    
    // 3. Check the local cache.
    const { premiumCache } = await chrome.storage.local.get('premiumCache');
    const now = Date.now();

    // --- SECURE CACHE LOGIC ---
    // Trust the cache ONLY if:
    // - A payment is NOT pending, AND
    // - The cache exists, AND
    // - The cached email MATCHES the current user's email, AND
    // - The cached status is 'paid', AND
    // - The cache is not older than 24 hours.
    if (!isPaymentPending && premiumCache && premiumCache.email === currentUser.email && premiumCache.status === 'paid' && (now - premiumCache.timestamp < PREMIUM_CACHE_DURATION)) {
        console.log(`Using fresh cached 'paid' status for user: ${currentUser.email}`);
        return { status: 'paid', promoData: null };
    }
    
    // 4. If no valid cache, proceed to a full server check using the current user's token.
    const fetchStatus = async () => {
        const response = await fetch(VERIFICATION_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify', token: currentUser.token })
        });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        return await response.json();
    };

    try {
        const data = await retryWithBackoff(fetchStatus);
        
        // 5. IMPORTANT: When caching, we also save the user's email.
        if (data.status === 'paid') {
            await chrome.storage.local.set({ 
                premiumCache: { 
                    status: 'paid', 
                    timestamp: now,
                    email: currentUser.email // <-- Link the cache to the user
                }
            });
        }
        
        if (isPaymentPending) {
            await chrome.storage.local.set({ paymentState: 'completed' });
        }
        
        return data;
    
    } catch (error) {
        return premiumCache || { status: 'not_premium', promoData: null };
    }
}
// --- END OF NEW SECTION ---

/////////// Initialize the page ///////////
document.addEventListener('DOMContentLoaded', async () => {
    const container = document.querySelector('.contain');
    try {

        // --- Immediately render the button in its "Authenticating..." state ---
        container.innerHTML = `
            <div class="content-block">
                <button id="statusButton" class="action-button" disabled>Authenticating...</button>
            </div>
        `;

        // This function will now handle the entire payment flow
        async function handlePaymentRequest(statusButton, promoData = null) {
            // Set button to "Processing..." state
            statusButton.disabled = true;
            statusButton.textContent = 'Processing...';
            statusButton.style.backgroundColor = '#cccccc';

            try {
                const token = await new Promise((resolve, reject) => {
                    chrome.identity.getAuthToken({ interactive: true }, token => {
                        if (chrome.runtime.lastError || !token) reject(new Error('Could not get auth token.'));
                        else resolve(token);
                    });
                });
                
                const fetchCheckoutUrl = async () => {
                    const response = await fetch(VERIFICATION_ENDPOINT, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'createCheckout',
                            token: token
                        })
                    });
                    if (!response.ok) throw new Error(`Server error: ${response.status}`);
                    return await response.json();
                };

                const data = await retryWithBackoff(fetchCheckoutUrl);

                if (data.checkoutUrl) {
                    // Show the instructions dialog
                    container.innerHTML = `
                        <h2>Payment Instructions</h2>
                        <div class="content-block">
                            <p>You will be redirected to the payment page.</p>
                            <p>After completing the payment, please close this window and open the extension again to see your premium status.</p>
                            <div style="display: flex; gap: 10px; margin-top: 20px; justify-content: center;">
                                <button id="cancelButton" class="cancel-button">Cancel</button>
                                <button id="proceedButton" class="proceed-button">Proceed to Payment</button>
                            </div>
                        </div>
                    `;

                    // Get references to the newly created buttons
                    if (promoData) {
                        // If we started from a promo, "Cancel" should re-render the promo screen.
                        cancelButton.addEventListener('click', () => renderDiscountScreen(promoData));
                    } else {
                        // Otherwise, it renders the standard "Donate" screen.
                        cancelButton.addEventListener('click', renderDonateScreen);
                    }
                    const proceedButton = document.getElementById('proceedButton');
                    
                    proceedButton.addEventListener('click', async () => {
                        // Disable both buttons immediately
                        cancelButton.disabled = true;
                        proceedButton.disabled = true;

                        await chrome.storage.local.set({ paymentState: 'pending' });
                        chrome.tabs.create({ url: data.checkoutUrl });
                    });

                } else {
                    throw new Error('Could not retrieve checkout URL.');
                }
            } catch (error) {
                console.error('Payment Setup Error:', error);
                container.innerHTML = `<p class="error-message">Failed to start payment: ${error.message}</p>`;
            }
        }

        // This function restores the button to its initial, clickable state
        function renderDonateScreen() {
            container.innerHTML = `
                <div class="content-block">
                    <button id="statusButton" class="action-button">Enable Premium Features</button>
                </div>
            `;
            const statusButton = document.getElementById('statusButton');
            document.getElementById('statusButton').addEventListener('click', () => handlePaymentRequest(statusButton, null));
        }

        function renderDiscountScreen(promoData) {
            const container = document.querySelector('.contain');
            container.innerHTML = `
                <div class="content-block promo-box promo-box-discount">
                    <p class="promo-message">${promoData.message} (${promoData.daysLeft} days left!)</p>
                    <p class="price-details">
                        <span class="original-price">${promoData.originalPrice}</span>
                        <strong class="sale-price"> ${promoData.salePriceText}</strong>
                    </p>
                    <button id="promoButton" class="action-button">${promoData.buttonText}</button>
                </div>
            `;
            const promoButton = document.getElementById('promoButton');
            promoButton.addEventListener('click', () => handlePaymentRequest(promoButton, promoData));
        }

        const userState = await getPremiumStatus(); // This gets an object like { status: '...', promoData: {...} }

        // Step 1: Handle premium feature access. This is granted for BOTH 'paid' and 'free_promo'.
        if (userState.status === 'paid' || userState.status === 'free_promo') {
        premiumFunction(true);
        displayPremiumUI();
        } else {
            premiumFunction(false);
        }
        console.log('User state:', userState);
        // Step 2: Render the correct UI in the container.
        switch (userState.status) {
            case 'paid':
                // For paid users, the container is completely hidden.
                container.innerHTML = '';
                container.style.display = 'none';
                break;

            case 'free_promo':
                // For 'free_promo' users, show the non-interactive message.
                container.innerHTML = `
                    <div class="content-block promo-box promo-box-free">
                        <p class="promo-message">${userState.promoData.message} (${userState.promoData.daysLeft} days left!)</p>
                    </div>
                `;
                break;

            case 'not_premium':
                // If there's discount data, show the discount UI.
                if (userState.promoData && userState.promoData.type === 'DISCOUNT') {
                    renderDiscountScreen(userState.promoData);
                } else {
                    // No promos, render the standard payment button.
                    renderDonateScreen();
                }
                break;
        }
            } catch (error) {
            // --- THIS CATCH BLOCK HANDLES THE "NOT SIGNED IN" STATE ---
            console.warn('Silent authentication failed:', error.message);
            
            // Render a dedicated "Sign In" button.
            container.innerHTML = `
                <div class="content-block">   
                    <p class="info-text">To use the app's features, please sign in.</p>
                    <p id="cancellationParagraph" class="info-text">If you are still here, click the button below to try again.</p>
                    <button id="signInButton" class="action-button">Sign in with Google</button>
                </div>
            `;

            const signInButton = document.getElementById('signInButton');

            signInButton.addEventListener('click', () => {
            // When the user clicks, we NOW trigger the interactive sign-in.
            signInButton.disabled = true;
            signInButton.textContent = 'Opening Sign-In...';

            // Set a timeout to handle cases where the callback doesn't fire
            // const timeoutId = setTimeout(() => {
            //     console.warn('Sign-in process timed out - likely user closed the window');
            //     resetSignInButton();
            // }, 60000); // 60 second timeout

            // // Function to reset the button state
            // const resetSignInButton = () => {
            //     clearTimeout(timeoutId);
            //     signInButton.disabled = false;
            //     signInButton.textContent = 'Sign in with Google';
            // };

             let hasBeenHandled = false;

            // This function contains the logic to reset the UI after a cancellation.
            const handleCancellation = () => {
                if (hasBeenHandled) return; // Prevent this from running twice
                hasBeenHandled = true;

                // IMPORTANT: Always remove the focus listener to prevent memory leaks
                window.removeEventListener('focus', focusHandler);

                document.getElementById('cancellationParagraph').style.display = 'block';
                signInButton.textContent = 'Sign-in cancelled. Please try again.';
                setTimeout(() => {
                    signInButton.disabled = false;
                    signInButton.textContent = 'Sign in with Google / Refresh';
                }, 2000);
            };

            // This is the new focus handler. It acts as our "early cancellation" detector.
            const focusHandler = () => {
                // If the main window gets focus back, it means the user closed the popup.
                // We handle the cancellation immediately.
                handleCancellation();
            };

            // Start listening for the focus event right before we open the popup.
            window.addEventListener('focus', focusHandler);

            // Trigger the interactive sign-in.
            chrome.identity.getAuthToken({ interactive: true }, (token) => {
                // This callback runs when the process is officially complete (success or failure).
                
                // ALWAYS remove the focus listener here. This is crucial cleanup.
                // It prevents the focus handler from firing if the user signs in successfully
                // and then immediately clicks back to the window.
                window.removeEventListener('focus', focusHandler);

                if (hasBeenHandled) return; // If the focus handler already ran, do nothing.
                hasBeenHandled = true;

                if (token) {
                    // Sign-in was successful! Reload the extension.
                    window.location.reload(); 
                } else {
                    // This handles the case where the API returns an error for other reasons.
                    handleCancellation();
                }
            });
        });
    }
});
