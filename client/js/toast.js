/* Sakura Toast - lightweight toast notification used across pages
 * - Non-blocking, auto-dismiss
 * - Title: nowrap to avoid awkward line breaks like "物語へ移\n動"
 * - Sizes: responsive via clamp; safe for JP text; balanced wrap for body when supported
 */
(function () {
  if (window.showSakuraToast) return; // singleton

  const STYLE_ID = 'wa-toast-style';
  function injectStyleOnce() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
    :root { --wa-toast-w: 380px; }
    .wa-toast { position: fixed; top: 20px; right: 20px; z-index: 10000;
      width: min(var(--wa-toast-w), calc(100vw - 32px));
      background: var(--gradient-sakura);
      border: 2px solid var(--enjhi);
      border-radius: var(--border-radius-large);
      box-shadow: var(--shadow-strong);
      color: var(--sumi);
      padding: 12px 14px 10px 14px;
      display: grid; grid-template-columns: auto 1fr auto; column-gap: 10px; row-gap: 6px;
      transform: translateX(120%); opacity: 0; backdrop-filter: blur(2px);
    }
    /* タイトル: 改行禁止＆サイズ抑制 */
    .wa-toast .wa-toast-title {
      font-family: var(--font-accent, inherit);
      font-weight: 700;
      color: var(--enjhi);
      font-size: clamp(0.95rem, 2.0vw, 1.15rem);
      line-height: 1.18;
      white-space: nowrap; /* 物語へ移動 が途中改行されないように */
      overflow: hidden; /* はみ出し防止 */
      text-overflow: ellipsis; /* はみ出す場合は… */
      min-width: 0; /* gridアイテムでの省スペース許可 */
      letter-spacing: 0.02em;
    }
    /* 本文: 読みやすい行間と折返し */
    .wa-toast .wa-toast-text {
      grid-column: 2 / span 2;
      font-size: clamp(0.88rem, 1.8vw, 0.98rem);
      line-height: 1.55;
      text-wrap: balance;
      word-break: normal;
      overflow-wrap: anywhere; /* 長い英数が来たときだけ折り返し */
    }
    .wa-toast .wa-toast-icon { font-size: 1.25rem; align-self: center; }
    .wa-toast .wa-toast-close { border: none; background: transparent; color: var(--enjhi);
      font-weight: 700; font-size: 1rem; cursor: pointer; line-height: 1; align-self: start; padding: 0 4px; }
    .wa-toast .wa-toast-progress { grid-column: 1 / -1; height: 3px; border-radius: 999px; overflow: hidden; background: rgba(178,45,53,.15); }
    .wa-toast .wa-toast-progress > span { display: block; height: 100%; width: 100%; background: linear-gradient(90deg, var(--enjhi), var(--yamabuki)); transform-origin: left center; }
    .wa-toast.show { animation: waToastIn .26s ease-out forwards; }
    .wa-toast.hide { animation: waToastOut .22s ease-in forwards; }
    @keyframes waToastIn { from { transform: translateX(120%); opacity: 0;} to { transform: translateX(0); opacity: 1;} }
    @keyframes waToastOut { from { transform: translateX(0); opacity: 1;} to { transform: translateX(120%); opacity: 0;} }
    @media (prefers-reduced-motion: reduce) {
      .wa-toast.show, .wa-toast.hide { animation: fade .16s linear forwards; }
      @keyframes fade { from { opacity: 0;} to { opacity: 1;} }
    }
    @media (max-width: 420px) {
      :root { --wa-toast-w: 92vw; }
      .wa-toast { right: 12px; top: 12px; }
      .wa-toast .wa-toast-title { font-size: clamp(0.95rem, 3.4vw, 1.05rem); }
      .wa-toast .wa-toast-text { font-size: clamp(0.86rem, 3.2vw, 0.95rem); }
    }
    `;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showSakuraToast(message, duration = 1600, title = '画面切替のお知らせ', icon = '🌸') {
    injectStyleOnce();
    // 既存トーストを消してから表示（重なりを避ける）
    document.querySelectorAll('.wa-toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = 'wa-toast show';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <div class="wa-toast-icon">${icon}</div>
      <div class="wa-toast-title">${title}</div>
      <button class="wa-toast-close" aria-label="閉じる">×</button>
      <div class="wa-toast-text">${message}</div>
      <div class="wa-toast-progress"><span></span></div>
    `;
    const closeBtn = toast.querySelector('.wa-toast-close');
    closeBtn.addEventListener('click', () => toast.remove());

    document.body.appendChild(toast);

    // 進捗バー
    const bar = toast.querySelector('.wa-toast-progress > span');
    const key = 'waBarShrink_' + Math.random().toString(36).slice(2);
    const barStyle = document.createElement('style');
    barStyle.textContent = `@keyframes ${key} { from { transform: scaleX(1);} to { transform: scaleX(0);} }`;
    document.head.appendChild(barStyle);
    bar.style.animation = `${key} linear ${duration}ms forwards`;

    // 自動消滅
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 230);
    }, duration);

    return toast; // 連携したいときのために返す
  }

  window.showSakuraToast = showSakuraToast;
})();
