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

// Global Cookie Consent Popup
(function () {
  function initCookieBanner() {
    try {
      if (localStorage.getItem('ppg_cookies_accepted')) return;
    } catch (e) { return; }

    var banner = document.createElement('div');
    banner.id = 'ppg-cookie-popup';
    banner.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);width:calc(100% - 28px);max-width:540px;padding:12px 16px;background:var(--page,#fff);color:var(--ink,#111);border:1px solid var(--bline,#9db9d4);border-radius:calc(var(--r,4px) * 2);box-shadow:0 6px 24px rgba(0,20,50,0.25);z-index:99999;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-family:var(--font,sans-serif);font-size:13px;box-sizing:border-box;';

    var msg = document.createElement('div');
    msg.style.cssText = 'flex:1 1 280px;line-height:1.4;';
    msg.innerHTML = '<strong>Cookie Notice:</strong> We use cookies and local storage to remember your theme, game progress, and account settings.';

    var btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    var btnAccept = document.createElement('button');
    btnAccept.className = 'go';
    btnAccept.type = 'button';
    btnAccept.textContent = 'Accept All';
    btnAccept.style.cssText = 'padding:5px 14px;cursor:pointer;font-weight:bold;';
    btnAccept.onclick = function () {
      try { localStorage.setItem('ppg_cookies_accepted', 'all'); } catch (e) {}
      banner.remove();
    };

    var btnEssential = document.createElement('button');
    btnEssential.className = 'btn';
    btnEssential.type = 'button';
    btnEssential.textContent = 'Essential Only';
    btnEssential.style.cssText = 'padding:5px 12px;cursor:pointer;';
    btnEssential.onclick = function () {
      try { localStorage.setItem('ppg_cookies_accepted', 'essential'); } catch (e) {}
      banner.remove();
    };

    btnGroup.appendChild(btnEssential);
    btnGroup.appendChild(btnAccept);
    banner.appendChild(msg);
    banner.appendChild(btnGroup);

    document.body.appendChild(banner);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCookieBanner);
  } else {
    initCookieBanner();
  }
})();

