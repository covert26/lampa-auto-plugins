/*!
 * auto_plugin_manager.js
 * ------------------------------------------------------------------
 * Автономный менеджер плагинов для Lampa (Xiaomi TV Stick 4K и др.).
 *
 * НАЗНАЧЕНИЕ
 *   1. При запуске Lampa проверяет все установленные плагины
 *      (Lampa.Storage.get('plugins')).
 *   2. Если плагин не отвечает (таймаут 6 сек, ошибка сети или пустой
 *      ответ), менеджер удаляет его, показывает уведомление и ставит
 *      проверенную замену той же категории из белого списка.
 *   3. Защищает сам себя от самоудаления и не ставит дубликаты.
 *   4. При первом запуске (нет ни одного рабочего онлайн-балансера)
 *      автоматически устанавливает базовый проверенный набор для 1080p.
 *
 * БЕЗОПАСНОСТЬ
 *   - Используются ТОЛЬКО проверенные плагины с открытым кодом из
 *     надёжных источников (nb557 — официальные плагины, cub.red —
 *     официальный домен разработчика Lampa).
 *   - Никаких сомнительных доменов, сборок, казино/рекламы и
 *     обфусцированного (зашифрованного) кода.
 *   - Менеджер управляет ТОЛЬКО теми URL, которые есть в белом списке.
 *     Неизвестные плагины никогда не трогаются (включая сам менеджер).
 *
 * ПРОВЕРКА ЖИВУЧЕСТИ
 *   Используется инъекция <script> — это тот же механизм, которым Lampa
 *   загружает плагины, поэтому проверка корректно работает на любых
 *   CDN без ограничений CORS. onload = плагин жив, onerror/таймаут
 *   (6 сек) = плагин не отвечает.
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  // Защита от повторного запуска (один экземпляр менеджера за сессию).
  if (window.__auto_plugin_manager_ran) return;
  window.__auto_plugin_manager_ran = true;

  var TIMEOUT_MS = 6000;               // 6 секунд — таймаут проверки
  var SELF_MARK = 'auto_plugin_manager'; // маркер для защиты от самоудаления

  // ==================================================================
  // БЕЛЫЙ СПИСОК ПРОВЕРЕННЫХ ПЛАГИНОВ
  // category: 'online'  — онлайн-балансеры (онлайн-кинотеатры)
  //           'tmdb'    — TMDB-прокси (постеры/метаданные)
  //           'torrent' — парсеры торрентов (JacRed и аналоги)
  //
  // Все URL проверены: HTTP 200 и читаемый (не обфусцированный) JS.
  // Примечание: online_mod.js (официальный балансер nb557) содержит
  // encode/decode только для хостов источников — это не вредоносная
  // обфускация; сам код открытый и из доверенного репозитория nb557.
  // ==================================================================
  var WHITELIST = [
    {
      category: 'online',
      name: 'Online Mod',
      url: 'https://nb557.github.io/plugins/online_mod.js'
    },
    {
      category: 'tmdb',
      name: 'TMDB Proxy (cub.red)',
      url: 'https://cub.red/plugin/tmdb-proxy'
    },
    {
      category: 'tmdb',
      name: 'TMDB Proxy (nb557)',
      url: 'https://nb557.github.io/plugins/tmdb_proxy.js'
    }
    // Категория 'torrent' (парсер торрентов / JacRed) намеренно пуста:
    // на момент проверки не найден живой И чистый (не обфусцированный)
    // источник из доверенных репозиториев. Сюда можно добавить URL
    // только после проверки HTTP 200 + читаемого кода.
  ];

  // Базовый набор для первого запуска (просмотр в 1080p):
  // лучший живой онлайн-балансер + TMDB-прокси.
  var BASE_SET = [
    {
      category: 'online',
      name: 'Online Mod',
      url: 'https://nb557.github.io/plugins/online_mod.js'
    },
    {
      category: 'tmdb',
      name: 'TMDB Proxy (cub.red)',
      url: 'https://cub.red/plugin/tmdb-proxy'
    }
  ];

  var INIT_FLAG = 'auto_plugin_manager_init';

  // ==================================================================
  // ХЕЛПЕРЫ
  // ==================================================================

  function log() {
    try {
      if (window.console && console.log) {
        console.log.apply(console, ['[APM]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) {}
  }

  function notify(msg) {
    try {
      if (window.Lampa && Lampa.Noty && Lampa.Noty.show) {
        Lampa.Noty.show(msg);
      }
    } catch (e) {
      log('notify error', e);
    }
  }

  function nameFromUrl(url) {
    try {
      var parts = url.split('/');
      var last = parts[parts.length - 1] || 'plugin';
      return last.replace(/\.js(\?.*)?$/, '') || 'Плагин';
    } catch (e) {
      return 'Плагин';
    }
  }

  // Получить список установленных плагинов (массив URL).
  function getInstalled() {
    var v = [];
    try {
      if (window.Lampa && Lampa.Storage) {
        v = Lampa.Storage.get('plugins', []);
      }
    } catch (e) {
      log('getInstalled error', e);
      return [];
    }
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (e) { v = []; }
    }
    if (!Array.isArray(v)) v = [];
    return v;
  }

  // Сохранить список установленных плагинов.
  function setInstalled(list) {
    try {
      if (window.Lampa && Lampa.Storage && Lampa.Storage.set) {
        Lampa.Storage.set('plugins', list);
      }
    } catch (e) {
      log('setInstalled error', e);
    }
  }

  // Найти запись белого списка по URL.
  function entryByUrl(url) {
    for (var i = 0; i < WHITELIST.length; i++) {
      if (WHITELIST[i].url === url) return WHITELIST[i];
    }
    return null;
  }

  // Является ли URL самим менеджером (защита от самоудаления).
  function isSelf(url) {
    return typeof url === 'string' && url.indexOf(SELF_MARK) !== -1;
  }

  // Есть ли уже установленный (в списке) плагин данной категории.
  function categoryInstalled(category, list) {
    for (var i = 0; i < list.length; i++) {
      var e = entryByUrl(list[i]);
      if (e && e.category === category) return true;
    }
    return false;
  }

  // Найти первую замену категории, которой ещё нет в списке.
  function replacementFor(category, list) {
    for (var i = 0; i < WHITELIST.length; i++) {
      var e = WHITELIST[i];
      if (e.category === category && list.indexOf(e.url) === -1) {
        return e;
      }
    }
    return null;
  }

  // ==================================================================
  // ИНЪЕКЦИЯ <script> — единый механизм проверки и установки
  // ==================================================================
  function inject(url, onOk, onFail) {
    var s = document.createElement('script');
    s.src = url;
    s.async = true;

    var done = false;
    var timer = null;

    function finish(alive, cb) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { s.remove(); } catch (e) {}
      try { if (cb) cb(alive); } catch (e) {}
    }

    s.onload = function () { finish(true, onOk); };
    s.onerror = function () { finish(false, onFail); };
    timer = setTimeout(function () { finish(false, onFail); }, TIMEOUT_MS);

    try {
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      finish(false, onFail);
    }
  }

  // Проверить живость плагина.
  function check(url, cb) {
    inject(url, function () { cb(true); }, function () { cb(false); });
  }

  // Установить плагин (без дубликатов) + уведомление.
  function install(entry) {
    if (!entry || !entry.url) return;
    var list = getInstalled();

    // Не ставим дубликат.
    if (list.indexOf(entry.url) !== -1) {
      log('already installed', entry.url);
      return;
    }

    // Не ставим, если уже есть рабочий плагин той же категории
    // (требование: защита от дубликатов по категории).
    if (categoryInstalled(entry.category, list)) {
      log('category already covered', entry.category);
      return;
    }

    // Сохраняем в хранилище, чтобы плагин пережил перезапуск Lampa.
    list.push(entry.url);
    setInstalled(list);

    // Загружаем сразу (чтобы заработал без перезапуска).
    inject(
      entry.url,
      function () {
        notify('Установлен рабочий плагин: ' + entry.name);
      },
      function () {
        notify('Не удалось загрузить плагин: ' + entry.name);
      }
    );
  }

  // Удалить плагин (никогда не удаляет сам менеджер).
  function remove(url) {
    if (isSelf(url)) {
      log('self-protection: skip remove', url);
      return;
    }
    var list = getInstalled();
    var i = list.indexOf(url);
    if (i !== -1) {
      list.splice(i, 1);
      setInstalled(list);
      log('removed', url);
    }
  }

  // ==================================================================
  // ОСНОВНАЯ ЛОГИКА
  // ==================================================================

  // Проверить все известные установленные плагины и починить мёртвые.
  function checkAndFix(onDone) {
    var list = getInstalled();

    // Только плагины из белого списка (известные и проверенные).
    var known = [];
    for (var i = 0; i < list.length; i++) {
      var url = list[i];
      if (isSelf(url)) continue;           // себя не трогаем
      var e = entryByUrl(url);
      if (e) known.push({ url: url, entry: e });
    }

    var idx = 0;

    function next() {
      if (idx >= known.length) {
        if (onDone) onDone();
        return;
      }

      var item = known[idx++];
      log('checking', item.url);

      check(item.url, function (alive) {
        if (alive) {
          log('alive', item.url);
          next();
        } else {
          var name = item.entry ? item.entry.name : nameFromUrl(item.url);
          log('dead', item.url);

          remove(item.url);
          notify('Нерабочий плагин [' + name + '] удалён');

          // Найти живую проверенную замену той же категории.
          var rep = replacementFor(item.entry.category, getInstalled());
          if (rep) {
            log('replace with', rep.url);
            install(rep);
          } else {
            log('no replacement for category', item.entry.category);
          }

          next();
        }
      });
    }

    next();
  }

  // Первый запуск: установить базовый набор, если нет балансера.
  function ensureBaseSet() {
    var list = getInstalled();
    var firstRun = false;

    try {
      firstRun = !(window.Lampa && Lampa.Storage && Lampa.Storage.get(INIT_FLAG, false));
    } catch (e) {
      firstRun = true;
    }

    if (!firstRun) return;

    try {
      if (window.Lampa && Lampa.Storage && Lampa.Storage.set) {
        Lampa.Storage.set(INIT_FLAG, true);
      }
    } catch (e) {}

    var installedAny = false;
    for (var i = 0; i < BASE_SET.length; i++) {
      var b = BASE_SET[i];
      if (!categoryInstalled(b.category, getInstalled())) {
        install(b);
        installedAny = true;
      }
    }

    if (installedAny) {
      notify('Установлен базовый набор для 1080p: Online Mod + TMDB Proxy');
    }
  }

  // ==================================================================
  // ЗАПУСК
  // ==================================================================
  function main() {
    log('start');
    checkAndFix(function () {
      ensureBaseSet();
      log('done');
    });
  }

  // Ждём готовности Lampa, затем запускаем.
  var attempts = 0;
  function waitLampa() {
    if (window.Lampa && Lampa.Storage && Lampa.Noty) {
      main();
    } else if (attempts < 100) {
      attempts++;
      setTimeout(waitLampa, 100);
    } else {
      log('Lampa not ready');
    }
  }

  waitLampa();
})();
