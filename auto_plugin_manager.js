/*!
 * auto_plugin_manager.js
 * ------------------------------------------------------------------
 * Автономный менеджер плагинов для Lampa (Xiaomi TV Stick 4K и др.).
 *
 * ЧТО ДЕЛАЕТ
 *   1. При запуске Lampa проверяет ВСЕ реально загруженные плагины, а не
 *      только свой список. Источник истины — собственный механизм Lampa:
 *         Lampa.Plugins.errors()  -> URL, которые НЕ загрузились
 *         Lampa.Plugins.loaded()   -> URL, которые успешно создались
 *         Lampa.Plugins.awaits()   -> ПОЛНЫЙ список активных плагинов
 *                                    (аккаунт CUB + Lampa.Storage.get('plugins')
 *                                     + встроенные плагины форка)
 *      «Мёртвые» = errors() объединить с (awaits() минус loaded()).
 *   2. Каждый нерабочий плагин удаляет из Lampa.Storage('plugins'),
 *      показывает уведомление «Нерабочий плагин [Имя] удалён» и ставит
 *      проверенную замену ТОЙ ЖЕ КАТЕГОРИИ из белого списка.
 *   3. При установке замены показывает «Установлен рабочий плагин: [Имя]».
 *   4. Защищает сам себя от самоудаления и не ставит дубликаты, если
 *      рабочий плагин этой категории уже присутствует.
 *   5. При первом запуске (нет рабочего онлайн-балансера) ставит базовый
 *      проверенный набор для 1080p с уведомлением.
 *
 * БЕЗОПАСНОСТЬ
 *   - Замены берутся ТОЛЬКО из проверенного белого списка (nb557.github.io —
 *     официальные плагины; cub.red — официальный домен разработчика Lampa).
 *   - Никаких сомнительных доменов, сборок, казино/рекламы и обфусцированного
 *     кода. Неизвестные категории («unknown») только удаляются и НИКОГДА не
 *     заменяются чем-либо сомнительным.
 *
 * ПРОВЕРКА ЖИВУЧЕСТИ
 *   - Базовый режим: используем результат самого Lampa
 *     (errors/loaded/awaits) — это точнее и не вызывает повторной загрузки.
 *   - Резервный режим (если API Lampa недоступно): инъекция <script> с
 *     параметрами и таймаутом 6 сек (та же схема, что у самой Lampa).
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  // Защита от повторного запуска за сессию.
  if (window.__auto_plugin_manager_ran) return;
  window.__auto_plugin_manager_ran = true;

  var TIMEOUT_MS = 6000;                       // 6 секунд на проверку плагина
  var SELF_MARK = 'auto_plugin_manager';       // маркер для защиты от самоудаления
  var INIT_FLAG = 'auto_plugin_manager_init';  // флаг «первого запуска»
  var MAX_WAIT = 150;                          // ~15 сек ожидания готовности Lampa

  // ==================================================================
  // БЕЛЫЙ СПИСОК ПРОВЕРЕННЫХ ЗАМЕН
  // category: 'online' | 'tmdb' | 'torrent'
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
    // Категория 'torrent' (JacRed и аналоги) намеренно пуста: нет живого
    // И одновременно чистого (не обфусцированного) источника из доверенных
    // репозиториев. Добавлять URL сюда можно только после проверки
    // HTTP 200 + читаемого кода.
  ];

  // Базовый набор для первого запуска (просмотр в 1080p).
  var BASE_SET = [WHITELIST[0], WHITELIST[1]];

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
      var parts = (url || '').split('?')[0].split('/');
      var last = parts[parts.length - 1] || 'plugin';
      return last.replace(/\.js$/, '') || 'Плагин';
    } catch (e) {
      return 'Плагин';
    }
  }

  function isSelf(url) {
    return typeof url === 'string' && url.indexOf(SELF_MARK) !== -1;
  }

  // Локальные/встроенные файлы, которые не являются внешними плагинами.
  function isLocal(url) {
    return typeof url === 'string' &&
      (url.indexOf('modification.js') !== -1 || url.indexOf('./plugins/') === 0);
  }

  // Определение категории плагина по URL (эвристика для замены «того же типа»).
  function categoryOf(url) {
    var u = (url || '').toLowerCase();
    if (isSelf(u)) return 'self';
    if (isLocal(u)) return 'local';
    if (u.indexOf('tmdb') !== -1) return 'tmdb';
    if (u.indexOf('online') !== -1 || u.indexOf('balancer') !== -1 ||
        u.indexOf('filmix') !== -1 || u.indexOf('kinopub') !== -1 ||
        u.indexOf('rezka') !== -1 || u.indexOf('skaz') !== -1 ||
        u.indexOf('amedia') !== -1 || u.indexOf('z01') !== -1) return 'online';
    if (u.indexOf('jacred') !== -1 || u.indexOf('jac.') !== -1 ||
        u.indexOf('torrent') !== -1 || u.indexOf('rutor') !== -1 ||
        u.indexOf('nnmclub') !== -1 || u.indexOf('bitru') !== -1 ||
        u.indexOf('rutracker') !== -1 || u.indexOf('parser') !== -1) return 'torrent';
    if (u.indexOf('/store/') !== -1 || u.indexOf('store.js') !== -1) return 'store';
    return 'unknown';
  }

  // ==================================================================
  // ХРАНИЛИЩЕ Lampa (Storage.get('plugins'))
  // Формат: массив объектов { url, status }. Поддерживаем и строки.
  // ==================================================================
  function rawList() {
    var v = [];
    try {
      if (window.Lampa && Lampa.Storage) v = Lampa.Storage.get('plugins', []);
    } catch (e) {
      return [];
    }
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (e) { v = []; }
    }
    if (!Array.isArray(v)) v = [];
    return v
      .map(function (a) { return (typeof a === 'string') ? { url: a, status: 1 } : a; })
      .filter(function (a) { return a && typeof a.url === 'string'; });
  }

  function currentUrls() {
    return rawList().map(function (a) { return a.url; });
  }

  function saveList(list) {
    try {
      if (window.Lampa && Lampa.Storage && Lampa.Storage.set) {
        Lampa.Storage.set('plugins', list);
      }
    } catch (e) {
      log('save error', e);
    }
  }

  // ==================================================================
  // ИСТОЧНИК ИСТИНЫ — РЕЗУЛЬТАТ САМОЙ LAMPA
  // ==================================================================
  // Возвращает массив URL мёртвых плагинов, либо null, если API недоступно.
  function lampaDead() {
    try {
      if (!window.Lampa || !Lampa.Plugins) return null;
      var errs = (Lampa.Plugins.errors && Lampa.Plugins.errors()) || [];
      var awaits = (Lampa.Plugins.awaits && Lampa.Plugins.awaits()) || [];
      var loaded = (Lampa.Plugins.loaded && Lampa.Plugins.loaded()) || [];
      var dead = {};

      errs.forEach(function (u) { dead[u] = true; });
      awaits.forEach(function (u) {
        if (loaded.indexOf(u) === -1) dead[u] = true; // не создался -> мёртв
      });
      return Object.keys(dead);
    } catch (e) {
      log('lampaDead error', e);
      return null;
    }
  }

  // ==================================================================
  // РЕЗЕРВНАЯ ПРОВЕРКА — ИНЪЕКЦИЯ <script> (как у Lampa)
  // ==================================================================
  function b64(s) {
    try { return window.btoa ? window.btoa(s) : s; } catch (e) { return s; }
  }

  // Добавить служебные параметры, как это делает Lampa (addPluginParams).
  function withParams(url) {
    try {
      // IP-адреса Lampa не «подписывает» параметрами.
      if (/[0-9]{1,3}(\.[0-9]{1,3}){3}/.test(url)) return url;
      var sep = url.indexOf('?') === -1 ? '?' : '&';
      return url + sep +
        'logged=false' +
        '&reset=' + Math.random() +
        '&origin=' + encodeURIComponent(b64(window.location.host));
    } catch (e) {
      return url;
    }
  }

  function probe(url, cb) {
    var s = document.createElement('script');
    s.src = withParams(url);
    s.async = true;

    var done = false;
    var timer = null;

    function finish(alive) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { s.remove(); } catch (e) {}
      try { cb(alive); } catch (e) {}
    }

    s.onload = function () { finish(true); };
    s.onerror = function () { finish(false); };
    timer = setTimeout(function () { finish(false); }, TIMEOUT_MS);

    try {
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      finish(false);
    }
  }

  // ==================================================================
  // ВЫБОР ЗАМЕНЫ
  // ==================================================================
  function entryInWhitelist(url) {
    for (var i = 0; i < WHITELIST.length; i++) {
      if (WHITELIST[i].url === url) return WHITELIST[i];
    }
    return null;
  }

  // Есть ли уже РАБОЧИЙ плагин этой категории (deadSet — множество мёртвых)?
  function categoryCoveredWorking(category, deadSet) {
    if (!category || category === 'unknown' || category === 'self' ||
        category === 'local' || category === 'store') return false;
    var urls = currentUrls();
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (deadSet && deadSet[u]) continue; // мёртвые не считаем
      if (categoryOf(u) === category) return true;
    }
    return false;
  }

  // Первая замена категории, которой ещё нет и которая нужна.
  function replacementFor(category, deadSet) {
    if (categoryCoveredWorking(category, deadSet)) return null;
    for (var i = 0; i < WHITELIST.length; i++) {
      var e = WHITELIST[i];
      if (e.category === category && currentUrls().indexOf(e.url) === -1) return e;
    }
    return null;
  }

  // ==================================================================
  // ДЕЙСТВИЯ
  // ==================================================================
  function removeByUrl(url) {
    if (isSelf(url)) {
      log('self-protection: skip remove', url);
      return;
    }
    var list = rawList();
    var filtered = list.filter(function (a) { return a.url !== url; });
    if (filtered.length !== list.length) {
      saveList(filtered);
      log('removed', url);
    }
  }

  function install(entry, deadSet) {
    if (!entry || !entry.url) return;

    if (currentUrls().indexOf(entry.url) !== -1) {
      log('already installed', entry.url);
      return;
    }
    if (categoryCoveredWorking(entry.category, deadSet)) {
      log('category already covered by working plugin', entry.category);
      return;
    }

    // Сохраняем в хранилище, чтобы плагин пережил перезапуск Lampa.
    var list = rawList();
    list.push({ url: entry.url, status: 1 });
    saveList(list);
    log('installing', entry.url);

    // Загружаем сразу (заработает без перезапуска) + уведомление.
    probe(entry.url, function (alive) {
      if (alive) notify('Установлен рабочий плагин: ' + entry.name);
      else notify('Не удалось загрузить плагин: ' + entry.name);
    });
  }

  // ==================================================================
  // ОСНОВНАЯ ЛОГИКА
  // ==================================================================
  function fixFromLampa() {
    var dead = lampaDead();
    if (dead === null) {
      log('Lampa.Plugins API недоступно -> резервная проверка');
      fixByProbe();
      return;
    }

    log('мёртвые (по данным Lampa):', dead);

    var deadMap = {};
    dead.forEach(function (u) { deadMap[u] = true; });

    dead.forEach(function (raw) {
      if (isSelf(raw) || isLocal(raw)) return;

      removeByUrl(raw);
      notify('Нерабочий плагин [' + nameFromUrl(raw) + '] удалён');

      var cat = categoryOf(raw);
      var rep = replacementFor(cat, deadMap);
      if (rep) {
        install(rep, deadMap);
      } else {
        log('нет проверенной замены для категории', cat, 'для', raw);
      }
    });

    ensureBaseSet(deadMap);
  }

  function fixByProbe() {
    var urls = currentUrls().filter(function (u) { return !isSelf(u) && !isLocal(u); });
    var i = 0;

    (function next() {
      if (i >= urls.length) {
        ensureBaseSet(null);
        return;
      }
      var u = urls[i++];
      log('probe', u);

      probe(u, function (alive) {
        if (alive) {
          next();
          return;
        }
        removeByUrl(u);
        notify('Нерабочий плагин [' + nameFromUrl(u) + '] удалён');

        var cat = categoryOf(u);
        var rep = replacementFor(cat, null);
        if (rep) install(rep, null);
        next();
      });
    })();
  }

  // Первый запуск: ставим базовый набор, если нет рабочего балансера.
  function ensureBaseSet(deadSet) {
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
      if (currentUrls().indexOf(b.url) !== -1) continue;
      if (categoryCoveredWorking(b.category, deadSet)) continue;
      install(b, deadSet);
      installedAny = true;
    }

    if (installedAny) {
      notify('Базовый набор для 1080p установлен: Online Mod + TMDB Proxy');
    }
  }

  // ==================================================================
  // ЗАПУСК: ждём готовности Lampa и заполнения списка плагинов
  // ==================================================================
  function start() {
    var tries = 0;

    (function step() {
      tries++;

      var ready = !!(window.Lampa && Lampa.Storage && Lampa.Noty && Lampa.Plugins);
      var populated = false;
      try {
        populated = !!(Lampa.Plugins && Lampa.Plugins.awaits &&
          (Lampa.Plugins.awaits() || []).length > 0);
      } catch (e) {}

      if (ready && populated) {
        log('start (tries=' + tries + ', populated=' + populated + ')');
        // Статусный пинг: подтверждает, что менеджер реально запущен и его
        // канал Lampa.Noty.show работает (видно на экране).
        notify('Менеджер плагинов активен: проверяю плагины…');
        fixFromLampa();
        return;
      }

      if (tries > MAX_WAIT) {
        log('timeout (populated=' + populated + ')');
        if (window.Lampa && Lampa.Plugins) fixFromLampa();
        else fixByProbe();
        return;
      }

      setTimeout(step, 100);
    })();
  }

  start();
})();
