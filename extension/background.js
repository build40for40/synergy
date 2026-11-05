// The toolbar button opens the dashboard in Chrome's side panel, next to whatever
// the user is reading (decided with Samira, card 170). Chrome remembers this setting,
// but setting it on every service worker start keeps it right after updates.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(error => console.error('Could not set the side panel behaviour', error));
