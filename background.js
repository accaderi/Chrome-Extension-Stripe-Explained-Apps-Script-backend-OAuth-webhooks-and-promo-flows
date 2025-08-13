// This listener fires when the user clicks the extension's icon in the toolbar.
chrome.action.onClicked.addListener(function(tab) {
  // Define the properties of the new window.
  const windowOptions = {
    url: chrome.runtime.getURL("main.html"), // Crucial: Use getURL to get the full, correct path.
    type: "popup", // Creates a window without browser chrome (address bar, etc.). Use "normal" for a regular window.
    width: 400,    // Specify the desired width.
    height: 600    // Specify the desired height.
  };

  // Create the new window.
  chrome.windows.create(windowOptions);
});