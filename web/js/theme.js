// Runs before first paint (a classic script in <head>): apply the theme the last person signed in here used,
// so a light-mode viewer never sees a flash of dark. The server's saved preference wins once the app loads.
try {
  var who = JSON.parse(localStorage.getItem('viewer'))
  var t = localStorage.getItem(who ? '@' + who + '/theme' : 'theme')
  if (t === '"light"' || t === '"dark"') document.documentElement.dataset.theme = JSON.parse(t)
} catch (e) {}
