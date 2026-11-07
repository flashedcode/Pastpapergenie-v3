// Applies the saved look (same ppg_prefs key as the main pastpapergenie site) before the page paints.
window.ppgApply = function () {
  var d = document.documentElement, p = {};
  try { p = JSON.parse(localStorage.getItem('ppg_prefs')) || {}; } catch (e) {}
  var F = { tahoma: 'Tahoma,Verdana,sans-serif', verdana: 'Verdana,Geneva,sans-serif', georgia: 'Georgia,"Times New Roman",serif', system: 'system-ui,sans-serif' };
  d.dataset.theme = p.theme || 'aero'; d.dataset.size = p.size || 'm';
  d.dataset.width = p.width || 'm'; d.dataset.corners = p.corners || 'rd';
  d.style.setProperty('--font', F[p.font] || F.tahoma);
};
ppgApply();
