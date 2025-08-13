/**
 * Configuration Section
 * ---------------------
 * IMPORTANT: Do NOT paste your secret keys directly into this script.
 * Go to Project Settings (gear icon on the left) > Script Properties and add them there.
 *
 * Add the following properties:
 * 1. STRIPE_SECRET_KEY: Your Stripe secret key (e.g., sk_test_...).
 * 2. WEBHOOK_SECRET_KEY: A secret key for the Stripe webhook (e.g., UUID).
 * 3. DEFAULT_PRICE_ID: The default price ID for the product.
 * Note: STRIPE_WEBHOOK_SECRET is not used because Google Apps Script does not reliably provide the necessary headers in the event object 'e'.
 */


const scriptProperties = PropertiesService.getScriptProperties();
const STRIPE_SECRET_KEY = scriptProperties.getProperty('STRIPE_SECRET_KEY');
const WEBHOOK_SECRET_KEY = scriptProperties.getProperty('WEBHOOK_SECRET_KEY'); // secret key because google removes the stripe secret key and the headers
const DEFAULT_PRICE_ID = scriptProperties.getProperty('DEFAULT_PRICE_ID'); // Price id for promotions as well
const SCRIPT_CACHE = CacheService.getScriptCache();

// Get the ID of the sheet to store data in.
const SPREADSHEET = SpreadsheetApp.getActiveSpreadsheet();
const PAYMENTS_SHEET = SPREADSHEET.getSheetByName('Payments');
if (!PAYMENTS_SHEET) {
  throw new Error("FATAL: Could not find the required sheet tab named 'Payments'. Please check for typos or create it.");
}
const LOGS_SHEET = SPREADSHEET.getSheetByName('Error Logs');
if (!LOGS_SHEET) {
  throw new Error("FATAL: Could not find the required sheet tab named 'Error Logs'. Please check for typos or create it.");
}
const PROMOTIONS_SHEET = SPREADSHEET.getSheetByName('Promotions'); // For promotions

// --- Main Request Handlers ---

/**
 * Handles ALL POST requests.
 * It differentiates between requests from the Chrome Extension and webhooks from Stripe.
 * It now uses a secret URL parameter to differentiate requests from Stripe.
 */

/**
 * Main entry point for all POST requests.
 */
function doPost(e) {
  try {
    if (e.parameter && e.parameter.webhook_secret === WEBHOOK_SECRET_KEY) {
      return handleStripeWebhook(e);
    }
    
    const payload = JSON.parse(e.postData.contents);
    const { action, token } = payload;

    if (!token) return createJsonResponse({ error: 'Missing authentication token' });
    
    const userInfo = verifyGoogleToken(token);
    if (!userInfo || !userInfo.email) return createJsonResponse({ error: 'Invalid or expired token' });
    
    const userEmail = userInfo.email;

    if (action === 'verify') return handleVerify(userEmail);
    if (action === 'createCheckout') return handleCreateCheckout(userEmail);

    return createJsonResponse({ error: 'Invalid action specified' });

  } catch (error) {
    logError('doPost_Global', error.message);
    return createJsonResponse({ error: 'An unexpected server error occurred.' });
  }
}

// --- FUNCTION FOR PRODUCT PROMOTION HANDLING: Reads promotion data from the sheet or from cahce---
function getActivePromotion() {
  const cacheKey = 'active_promotion_data';
  
  try {
    // --- FAST PATH: Attempt to retrieve data from the high-speed cache first ---
    const cachedData = SCRIPT_CACHE.get(cacheKey);
    if (cachedData !== null) {
      logError('getActivePromotion', 'Returning promotion data from CACHE.');
      // If found in cache, parse it and return it immediately.
      return createJsonResponse(JSON.parse(cachedData));
    }

    // --- SLOW PATH: If not in cache, read from the Google Sheet ---
    logError('getActivePromotion', 'Cache miss. Reading promotion data from SHEET.');
    const data = PROMOTIONS_SHEET.getDataRange().getValues();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const promoEndDateStr = row[0];
      let promoEndDate;
      try {
        if (promoEndDateStr) {
          promoEndDate = new Date(promoEndDateStr);
          if (isNaN(promoEndDate.getTime())) continue;
        } else {
          continue;
        }
      } catch (e) {
        continue;
      }
      promoEndDate.setHours(23, 59, 59, 999);

      if (promoEndDate >= today) {
        // --- An active promotion was found ---
        const timeDiff = promoEndDate.getTime() - today.getTime();
        const daysLeft = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
        
        const promoInfo = {
          hasPromo: true,
          type: row[1], promoCodeId: row[2], message: row[3],
          buttonText: row[4], salePriceText: row[5], originalPrice: row[6],
          daysLeft: daysLeft
        };

        // Store the found promotion in the cache for 10 minutes before returning
        SCRIPT_CACHE.put(cacheKey, JSON.stringify(promoInfo), 600); 
        return createJsonResponse(promoInfo);
      }
    }
    
    // --- If no active promotion was found after checking the sheet ---
    const noPromoInfo = { hasPromo: false };
    // Store the "no promo" result in the cache as well, to prevent re-checking the sheet for 10 minutes.
    SCRIPT_CACHE.put(cacheKey, JSON.stringify(noPromoInfo), 600);
    return createJsonResponse(noPromoInfo);
    
  } catch (error) {
    logError('getActivePromotion', `Error: ${error.message}`);
    // On any failure, return a safe "no promo" response.
    return createJsonResponse({ hasPromo: false });
  }
}

/**
 * Handles the Stripe webhook logic.
 * 
 * IMPORTANT NOTE: Signature verification is skipped because Google Apps Script does not
 * reliably provide the necessary headers in the event object 'e'.
 * The WEBHOOK_SECRET_KEY in the URL provides the necessary security.
 *
 */
function handleStripeWebhook(e) {
  const functionName = 'handleStripeWebhook';
  // --- Step 1: Immediately parse the event to get the ID ---
  // We do this first because the idempotency check is the most critical step.
  let event;
  try {
    event = JSON.parse(e.postData.contents);
  } catch (error) {
    logError(functionName, `FATAL: Could not parse incoming JSON. Error: ${error.message}`);
    // Acknowledge with a 200 OK to stop retries, even on a bad payload.
    return createStripeSuccessResponse();
  }

  // --- Step 2: Perform the Idempotency Check Immediately ---
  // This is extremely fast and ensures we don't do duplicate work.
  const eventId = event.id;
  if (isEventProcessed(eventId, PAYMENTS_SHEET)) {
      logError(functionName, `Webhook already processed: ${eventId}. Acknowledging and skipping.`);
      // Return a 200 OK immediately for duplicates.
      return createStripeSuccessResponse();
  }

  // --- Step 3: Now that we know it's a new event, do the real work ---
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userEmail = session.client_reference_id;

      if (userEmail) {
        PAYMENTS_SHEET.appendRow([userEmail, new Date(), eventId]);
        // SpreadsheetApp.flush(); // <-- REMOVED: This is causing a timeout.
        logError(functionName, `Successfully queued record for ${userEmail} with Event ID: ${eventId}.`);
        // A new user has paid, so the old cache is now invalid. We must clear it.
        SCRIPT_CACHE.remove('paid_users_list');
      } else {
        logError(functionName, 'ERROR: Missing client_reference_id in completed session.');
      }
    }
    
    // --- Step 4: Acknowledge receipt to Stripe with a 200 OK ---
    // This response is now sent much faster because we are not waiting for flush().
    return createStripeSuccessResponse();

  } catch (error) {
    logError(functionName, `FATAL ERROR during processing: ${error.message}`);
    // Even if our processing fails, we return a success code to Stripe to stop it from retrying.
    return createStripeSuccessResponse();
  }
}

// --- Helper function for idempotency check ---
function escapeRegExp(str) {
  // Escapes regex special characters in the input string
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isEventProcessed(eventId, sheet) {
    try {
        // Limit to only filled rows for efficiency
        const lastRow = sheet.getLastRow();
        if (lastRow < 1) return false;
        const eventIdRange = sheet.getRange(1, 3, lastRow, 1);

        // Ensure eventId is safe for regex by escaping special characters
        const escapedEventId = escapeRegExp(eventId);
        const regex = new RegExp(`^${escapedEventId}$`);

        const textFinder = eventIdRange
            .createTextFinder(regex.source)
            .useRegularExpression(true);

        const firstMatch = textFinder.findNext();
        return firstMatch !== null;

    } catch (error) {
        if (typeof logError === 'function') {
            logError(
                'isEventProcessed_Error',
                `An error occurred during search: ${error.message}`
            );
        }
        return false;
    }
}

/**
 * A highly optimized function to get the list of paid users.
 * Reads from the fast in-memory cache first, falling back to the "slow" sheet.
 */
function getPaidUsersFromCacheOrSheet() {
  const cacheKey = 'paid_users_list';
  const cachedData = SCRIPT_CACHE.get(cacheKey);

  // FAST PATH: Return the list from the cache
  if (cachedData !== null) {
    logError('getPaidUsers', 'Returning paid users list from CACHE.');
    return JSON.parse(cachedData);
  }

  // SLOW PATH: Read the full list from the sheet
  logError('getPaidUsers', 'Cache miss. Reading paid users list from SHEET.');
  const lastRow = PAYMENTS_SHEET.getLastRow();
  // Start from row 2 to skip header, read only the first column
  if (lastRow < 2) return []; 

  const emailList = PAYMENTS_SHEET.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  
  // Store the list in the cache for 1 hour (3600 seconds)
  SCRIPT_CACHE.put(cacheKey, JSON.stringify(emailList), 3600); 
  return emailList;
}

// --- Handler Implementations ---

function handleVerify(userEmail) {
  // 1. Get the list of paid users (this will be very fast).
  const paidUsers = getPaidUsersFromCacheOrSheet();
  // 2. Check if the user is in the list. This is a fast in-memory check.
  if (paidUsers.includes(userEmail)) {
  return createJsonResponse({ status: 'paid', promoData: null });
  }

  // 3. If the user is NOT paid, THEN we check for active promotions.
  const promoData = JSON.parse(getActivePromotion().getContent());
  
  if (promoData.hasPromo) {
    if (promoData.type === 'FREE') {
      logError('handleVerify', `Granting temporary free access to ${userEmail}.`);
      return createJsonResponse({ status: 'free_promo', promoData: promoData });
    } else { // It must be a DISCOUNT
      logError('handleVerify', `User ${userEmail} is not premium, but a discount is available.`);
      return createJsonResponse({ status: 'not_premium', promoData: promoData });
    }
  }

  // 4. If not paid and no promos are active, they are a standard non-premium user.
  // logError('handleVerify', `User ${userEmail} is NOT premium and no promos are active.`);
  return createJsonResponse({ status: 'not_premium', promoData: null });
}

/*
 * Function for stripe procuct handling
 */

function handleCreateCheckout(userEmail) {
  try {
    const finalPriceId = DEFAULT_PRICE_ID;
    const payload = {
      'line_items[0][price]': finalPriceId,
      'line_items[0][quantity]': '1',
      'customer_email': userEmail,
      'mode': 'payment',
      'success_url': 'https://example.com/success', // Replace with your actual success URL
      'cancel_url': 'https://example.com/cancel', // Replace with your actual cancel URL
      'client_reference_id': userEmail
    };

    // --- Check for an active discount promo ---
    const promoData = JSON.parse(getActivePromotion().getContent());
    if (promoData.hasPromo && promoData.type === 'DISCOUNT' && promoData.promoCodeId) {
      logError('handleCreateCheckout', `Applying promo code ID: ${promoData.promoCodeId}`);
      // Add the discount to the payload
      payload['discounts[0][promotion_code]'] = promoData.promoCodeId;
    }

    const stripeUrl = 'https://api.stripe.com/v1/checkout/sessions';
    const options = {
      method: 'post',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
      payload: payload,
      muteHttpExceptions: true,
    };
    
    const response = UrlFetchApp.fetch(stripeUrl, options);
    const data = JSON.parse(response.getContentText());

    if (data.url) {
      return createJsonResponse({ checkoutUrl: data.url });
    } else {
      throw new Error('Failed to create Stripe session: ' + (data.error ? data.error.message : 'Unknown error'));
    }
  } catch (error) {
    logError('handleCreateCheckout_Global', error.message);
    return createJsonResponse({ error: 'Could not create payment session.' });
  }
}

// --- Utility and Security Functions ---

// --- verifyGoogleToken ---
function verifyGoogleToken(token) {
  try {
    const response = UrlFetchApp.fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    return JSON.parse(response.getContentText());
  } catch (e) {
    // Log the actual error before returning null
    logError('verifyGoogleToken_Error', `UrlFetchApp failed. Error: ${e.message}`);
    return null;
  }
}

function logError(functionName, message) {
  LOGS_SHEET.appendRow([new Date(), functionName, message]);
}

function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Creates a simple HTML 200 OK response specifically for Stripe.
 * This is used as a workaround for the ContentService 302 redirect issue.
 */
function createStripeSuccessResponse() {
  // We return a minimal HTML output. When returned from doPost,
  // this generates a 200 OK status code that Stripe accepts.
  return HtmlService.createHtmlOutput("<p>OK</p>");
}

/**
 * ADMIN FUNCTIONS: Run from google script
 */

/**
 * ADMIN FUNCTION: Manually clears the promotion cache.
 * To use this, simply select "flushPromotionCache" from the function
 * dropdown in the Apps Script editor and click "Run".
 */
function flushPromotionCache() {
  try {
    SCRIPT_CACHE.remove('active_promotion_data');
    // Logger.log is used here so the confirmation message appears in the execution logs.
    Logger.log("SUCCESS: The promotion cache has been manually flushed.");
    // You can also add a browser alert for immediate feedback if you're running it interactively.
    Browser.msgBox("Success", "The promotion cache has been flushed.", Browser.Buttons.OK);
  } catch (error) {
    Logger.log(`ERROR: Failed to flush the cache. Reason: ${error.message}`);
    Browser.msgBox("Error", `Failed to flush the cache: ${error.message}`, Browser.Buttons.OK);
  }
}

/**
 * ADMIN FUNCTION: Manually clears the users cache.
 * To use this, simply select "flushUserCache" from the function
 * dropdown in the Apps Script editor and click "Run".
 */
function flushUserCache() {
  try {
    SCRIPT_CACHE.remove('paid_users_list');
    Logger.log("SUCCESS: The paid users cache has been manually flushed.");
    Browser.msgBox("Success", "The paid users cache has been flushed.", Browser.Buttons.OK);
  } catch (error) {
    Logger.log(`ERROR: Failed to flush the user cache. Reason: ${error.message}`);
    Browser.msgBox("Error", `Failed to flush the user cache: ${error.message}`, Browser.Buttons.OK);
  }
}

/**
 * ADMIN FUNCTION: Force the correct permission prompt
 */
function testExternalFetch() {
  try {
    UrlFetchApp.fetch("https://www.google.com/");
    Logger.log("Success! The script has permission to connect to external services.");
  } catch (e) {
    Logger.log("Failed to fetch. This is expected if you haven't authorized yet. Error: " + e.message);
  }
}