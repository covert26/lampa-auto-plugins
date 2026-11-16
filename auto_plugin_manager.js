/*!
 * auto_plugin_manager.js
 * ------------------------------------------------------------------
 * Автономный менеджер плагинов для Lampa (Xiaomi TV Stick 4K и др.).
 *
 * ЧТО ДЕЛАЕТ
 *   1. При запуске Lampa проверяет ВСЕ реально загруженные плагины, а не
 *      только свой список. Источник истины — собственный механизм Lampa:
 *         Lampa.Plugins.errors()  -> URL, которые НЕ загрузились (_noload)
 *         Lampa.Plugins.loaded()   -> URL, которые успешно создались
 *      «Мёртвые» = errors() объединить с заведомо мёртвыми подписями
 *      (BAD_SIGNATURES) и не отвечающими при резервном probe().
 *   2. Каждый нерабочий плагин удаляет из Lampa.Storage('plugins'),
 *      показывает уведомление «Удалён нерабочий плагин: [Имя]» и ставит
 *      проверенную замену ТОЙ ЖЕ КАТЕГОРИИ из белого списка.
 *   3. При установке замены показывает ОДНО аккуратное уведомление
 *      «Установлен рабочий плагин: [Имя]» (без дублей).
 *   4. Постоянно держит рабочие квоты по категориям (см. QUOTAS):
 *         online  — минимум 2 рабочих балансера (BwaRC + Online Mod)
 *         torrent — минимум 1 парсер JacRed (pubtorr)
 *         tmdb    — 1 прокси метаданных
 *         store   — 1 каталог расширений
 *   5. Защищает сам себя от самоудаления (SELF_MARK) и не ставит дубликаты.
 *   6. Дополнительно проверяет/поддерживает базовые настройки JacRed-парсера
 *      в Lampa.Storage, чтобы поиск торрентов работал «из коробки».
 *
 * БЕЗОПАСНОСТЬ
 *   - Замены берутся ТОЛЬКО из проверенного белого списка (nb557.github.io,
 *     lampame.github.io — официальные плагины; cub.red — официальный домен
 *     разработчика Lampa; bwa.ad — живой балансер BwaRC; lampaplugins — store).
 *   - Никаких сомнительных доменов, казино/рекламы и обфусцированного кода.
 *     Неизвестные категории («unknown») только удаляются и НИКОГДА не
 *     заменяются чем-либо сомнительным.
 *
 * ПРОВЕРКА ЖИВУЧЕСТИ
 *   - Базовый режим: используем результат самого Lampa
 *     (errors/loaded/awaits) — это точнее и не вызывает повторной загрузки.
 *   - Резервный режим (если API Lampa недоступно): инъекция <script> с
 *     параметрами и таймаутом 6 сек (та же схема, что у самой Lampa).
 *
 * ПРОВЕРЕНО (HTTP 200 на момент сборки):
 *   bwa.ad, nb557.github.io/plugins/online_mod.js,
 *   lampame.github.io/main/pubtorr/pubtorr.js,
 *   lampame.github.io/main/torrentmanager.js,
 *   cub.red/plugin/tmdb-proxy, nb557.github.io/plugins/tmdb_proxy.js,
 *   lampaplugins.github.io/store/store.js
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  // Защита от повторного запуска ТОЛЬКО в рамках одного контекста.
  // ВАЖНО: Lampa при установке плагина оборачивает код и перезагружает его
  // (ленивая инициализация), из-за чего жёсткий ранний return мог обрывать
  // выполнение. Используем мягкую защиту (не выходим до готовности Lampa).
  var APM_TOKEN = 'apm_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);

  var TIMEOUT_MS = 6000;                       // 6 секунд на проверку плагина
  var SELF_MARK = 'auto_plugin_manager';       // маркер для защиты от самоудаления
  var INIT_FLAG = 'auto_plugin_manager_init';  // флаг «первого запуска»
  var MAX_WAIT = 150;                          // ~15 сек ожидания готовности Lampa

  // ==================================================================
  // БЕЛЫЙ СПИСОК ПРОВЕРЕННЫХ ЗАМЕН (все URL отвечают HTTP 200)
  // category: 'online' | 'tmdb' | 'torrent' | 'store'
  // ==================================================================
  var WHITELIST = [
    // --- online: онлайн-балансеры (фильмы и сериалы) ---
    {
      category: 'online',
      name: 'BwaRC',
      url: 'https://bwa.ad/plugin.js'
    },
    {
      category: 'online',
      name: 'Online Mod (nb557)',
      url: 'https://nb557.github.io/plugins/online_mod.js'
    },
    // --- torrent: чистые парсеры JacRed / торрент-поиск ---
    {
      category: 'torrent',
      name: 'JacRed Parser (pubtorr, lampame)',
      url: 'https://lampame.github.io/main/pubtorr/pubtorr.js'
    },
    {
      category: 'torrent',
      name: 'Torrent Manager (lampame)',
      url: 'https://lampame.github.io/main/torrentmanager.js'
    },
    // --- tmdb: прокси обложек/рейтингов/описаний ---
    {
      category: 'tmdb',
      name: 'TMDB Proxy (cub.red)',
      url: 'https://cub.red/plugin/tmdb-proxy'
    },
    {
      category: 'tmdb',
      name: 'TMDB Proxy (nb557)',
      url: 'https://nb557.github.io/plugins/tmdb_proxy.js'
    },
    // --- store: каталог/магазин расширений (для ручного выбора) ---
    {
      category: 'store',
      name: 'Store (lampaplugins)',
      url: 'https://lampaplugins.github.io/store/store.js'
    }
  ];

  // Минимальные рабочие квоты по категориям, которые менеджер обязан держать.
  var QUOTAS = {
    online: 2,   // минимум ДВА рабочих онлайн-балансера
    torrent: 1,  // минимум один парсер JacRed / торрент-поиск
    tmdb: 1,     // один прокси метаданных
    store: 1     // один магазин расширений
  };

  // Признаки заведомо мёртвых / рекламных источников (проверено ADB-logcat
  // и HTTP-доступностью с приставки).
  // ВАЖНО: bwa.ad здесь ОТСУТСТВУЕТ — это живой балансер BwaRC.
  var BAD_SIGNATURES = [
    'z01.online', 'bwa.lampa.tv', 'bwa.lampa.to', 'bwa.to',
    'lampa.stream/modss', 'skaz.tv/amedia', 'lampa.mx/hdrezka',
    'jacred.ru/init.yaml', 'cub.red/plugin/torrent'
  ];

  // Проверка, что URL точно на доверенном хосте из белого списка.
  function isTrustedHost(url) {
    for (var i = 0; i < WHITELIST.length; i++) {
      if (WHITELIST[i].url === url) return true;
    }
    return false;
  }

  // Базовый набор для первого запуска — по одному плагину на каждую категорию.
  var BASE_SET = [
    WHITELIST[0], // online: BwaRC
    WHITELIST[2], // torrent: JacRed Parser
    WHITELIST[4], // tmdb: TMDB Proxy (cub.red)
    WHITELIST[6]  // store: Store (lampaplugins)
  ];

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
    if (isBadUrl(u)) return 'bad'; // заведомо мёртвый/рекламный источник
    if (u.indexOf('tmdb') !== -1) return 'tmdb';
    if (u.indexOf('store') !== -1) return 'store';
    if (u.indexOf('pubtorr') !== -1 || u.indexOf('torrentmanager') !== -1 ||
        u.indexOf('torrent-manager') !== -1) return 'torrent';
    if (u.indexOf('online') !== -1 || u.indexOf('balancer') !== -1 ||
        u.indexOf('bwa.') !== -1 || u.indexOf('filmix') !== -1 ||
        u.indexOf('kinopub') !== -1 || u.indexOf('rezka') !== -1 ||
        u.indexOf('skaz') !== -1 || u.indexOf('amedia') !== -1 ||
        u.indexOf('z01') !== -1) return 'online';
    if (u.indexOf('jacred') !== -1 || u.indexOf('jac.') !== -1 ||
        u.indexOf('torrent') !== -1 || u.indexOf('rutor') !== -1 ||
        u.indexOf('nnmclub') !== -1 || u.indexOf('bitru') !== -1 ||
        u.indexOf('rutracker') !== -1 || u.indexOf('parser') !== -1) return 'torrent';
    return 'unknown';
  }

  // Заведомо мёртвый / рекламный источник (см. BAD_SIGNATURES).
  function isBadUrl(url) {
    var u = (url || '').toLowerCase();
    for (var i = 0; i < BAD_SIGNATURES.length; i++) {
      if (u.indexOf(BAD_SIGNATURES[i]) !== -1) return true;
    }
    return false;
  }

  // Должен ли плагин быть удалён: явная «плохая» подпись + мёртвый по данным Lampa.
  function shouldRemove(url, deadSet) {
    if (isSelf(url) || isLocal(url) || isTrustedHost(url)) return false;
    if (isBadUrl(url)) return true;
    return !!(deadSet && deadSet[url]);
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
  // ИСТОЧНИК ИСТИНЫ — РЕЗУЛЬТАТ САМОЙ LAMPA (форк Lampa MX / top.rootu.lampa)
  // ==================================================================
  // Реальный API форка (см. app.min.js, объект Plugins):
  //   Lampa.Plugins.errors()  -> _noload : URL, которые НЕ загрузились
  //   Lampa.Plugins.loaded()  -> _created: URL, которые успешно создались
  // ВАЖНО: _noload наполняется асинхронно по мере ошибок загрузки, поэтому
  // снимать мёртвых имеет смысл только ПОСЛЕ того, как Lampa вызвала load().
  function lampaErrors() {
    try {
      if (!window.Lampa || !Lampa.Plugins || !Lampa.Plugins.errors) return null;
      return (Lampa.Plugins.errors() || []).slice();
    } catch (e) {
      log('lampaErrors error', e);
      return null;
    }
  }

  // Список активных плагинов из хранилища (формат {url,status} или строка).
  function lampaActive() {
    var urls = [];
    try {
      var v = [];
      if (window.Lampa && Lampa.Storage) {
        v = Lampa.Storage.get('plugins', []);
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = []; } }
      }
      if (!Array.isArray(v)) v = [];
      v.forEach(function (a) {
        var u = (typeof a === 'string') ? a : (a && a.url);
        if (typeof u === 'string' && u) urls.push(u);
      });
    } catch (e) {
      log('lampaActive error', e);
    }
    return urls;
  }

  // Ждём, пока Lampa реально начнёт загрузку плагинов (появится _awaits).
  function lampaReady() {
    try {
      if (!window.Lampa || !Lampa.Plugins) return false;
      var loaded = (Lampa.Plugins.loaded && Lampa.Plugins.loaded()) || [];
      var errs = (Lampa.Plugins.errors && Lampa.Plugins.errors()) || [];
      return (loaded.length > 0 || errs.length > 0 || lampaActive().length > 0);
    } catch (e) {
      return false;
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
  // ВЫБОР ЗАМЕНЫ И КВОТЫ ПО КАТЕГОРИЯМ
  // ==================================================================
  function entryInWhitelist(url) {
    for (var i = 0; i < WHITELIST.length; i++) {
      if (WHITELIST[i].url === url) return WHITELIST[i];
    }
    return null;
  }

  // Сколько РАБОЧИХ плагинов данной категории уже установлено.
  function categoryWorkingCount(category, deadSet) {
    var urls = currentUrls();
    var n = 0;
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (deadSet && deadSet[u]) continue;      // мёртвые не считаем
      if (isBadUrl(u)) continue;                // «плохие» не считаем
      if (categoryOf(u) === category) n++;
    }
    return n;
  }

  // Покрыта ли квота категории рабочими плагинами.
  function categoryCoveredWorking(category, deadSet) {
    if (!category || QUOTAS[category] === undefined) return false;
    return categoryWorkingCount(category, deadSet) >= QUOTAS[category];
  }

  // Следующая замена категории, которой не хватает до квоты.
  function replacementFor(category, deadSet) {
    if (QUOTAS[category] === undefined) return null;
    if (categoryCoveredWorking(category, deadSet)) return null;
    var urls = currentUrls();
    for (var i = 0; i < WHITELIST.length; i++) {
      var e = WHITELIST[i];
      if (e.category === category && urls.indexOf(e.url) === -1) return e;
    }
    return null;
  }

  // ==================================================================
  // ДЕЙСТВИЯ
  // ==================================================================
  // ВАЖНО (реальная семантика форка):
  //   Plugins.remove(plug) -> Arrays.remove(_loaded, plug); Storage.set('plugins', _loaded)
  //   где _loaded — массив ОБЪЕКТОВ {url,status}. Вызывать remove() НЕЛЬЗЯ:
  //   он пишет обратно в Storage свой устаревший _loaded и затирает нашу
  //   фильтрацию (проверено симуляцией). Поэтому фильтруем Storage напрямую.
  function removeByUrl(url) {
    if (isSelf(url)) {
      log('self-protection: skip remove', url);
      return false;
    }

    var list = rawList();
    var filtered = list.filter(function (a) { return a.url !== url; });
    if (filtered.length === list.length) return false; // нечего удалять

    saveList(filtered);
    log('removed', url);
    return true;
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

    log('installing', entry.url);

    // Инициализировать через официальный API форка (заработает без перезапуска).
    var usedApi = false;
    try {
      if (window.Lampa && Lampa.Plugins && Lampa.Plugins.push) {
        Lampa.Plugins.push({ url: entry.url, status: 1 });
        usedApi = true;
      }
    } catch (e) {
      log('Plugins.push error', e);
    }

    // Гарантированно сохраняем итоговый список в Storage (дедупликация).
    var list = rawList();
    if (list.map(function (a) { return a.url; }).indexOf(entry.url) === -1) {
      list.push({ url: entry.url, status: 1 });
    }
    saveList(list);

    // ОДНО уведомление: не дублируем (движок форка сам может показать
    // свой системный тост о добавлении, поэтому здесь только наш статус).
    var told = false;
    probe(entry.url, function (alive) {
      if (told) return;
      told = true;
      if (alive) notify('Установлен рабочий плагин: ' + entry.name);
      else notify('Не удалось загрузить плагин: ' + entry.name);
    });

    if (usedApi) log('installed via Plugins.push', entry.url);
  }

  // ==================================================================
  // ПОДДЕРЖКА БАЗОВЫХ НАСТРОЕК JACRED-ПАРСЕРА (чтобы поиск работал «из коробки»)
  // ==================================================================
  function ensureJacredSettings() {
    try {
      if (!window.Lampa || !Lampa.Storage) return;

      // Активный JacRed-хост (проверено: jacred.su отвечает 200).
      var jacHost = 'https://jacred.su';

      // Парсер торрентов: включаем и указываем хост, если пусто/бито.
      var parser = Lampa.Storage.get('torrent_parser', '');
      if (!parser) {
        Lampa.Storage.set('torrent_parser', jacHost);
        log('jacred: set torrent_parser =', jacHost);
      }

      // Включаем поиск через JacRed, если параметр ещё не задан.
      if (Lampa.Storage.get('jacred', null) === null) {
        Lampa.Storage.set('jacred', true);
      }

      // Включаем парсер торрентов, если выключен вручную быть не должен.
      if (Lampa.Storage.get('torrent_use_parser', null) === null) {
        Lampa.Storage.set('torrent_use_parser', true);
      }

      // Таймаут парсера (сек) — чтобы поиск не «висел» бесконечно.
      if (!Lampa.Storage.get('torrent_parser_timeout', '')) {
        Lampa.Storage.set('torrent_parser_timeout', 15);
      }
    } catch (e) {
      log('ensureJacredSettings error', e);
    }
  }

  // ==================================================================
  // ОСНОВНАЯ ЛОГИКА
  // ==================================================================
  function fixFromLampa() {
    var errs = lampaErrors();
    if (errs === null) {
      log('Lampa.Plugins API недоступно -> резервная проверка');
      fixByProbe();
      return;
    }

    var deadMap = {};
    errs.forEach(function (u) { deadMap[u] = true; });

    var active = lampaActive();
    log('active:', active);
    log('errors(_noload):', errs);

    var removed = 0;

    // Проходим по ВСЕМ активным URL: удаляем мёртвые и «плохие».
    active.forEach(function (u) {
      if (!shouldRemove(u, deadMap)) return;
      if (removeByUrl(u)) {
        removed++;
        notify('Удалён нерабочий плагин: ' + nameFromUrl(u));
      }
    });

    // Также учитываем мёртвые, которых уже нет в активном списке (из _noload).
    errs.forEach(function (u) {
      if (isSelf(u) || isLocal(u) || isTrustedHost(u)) return;
      if (active.indexOf(u) !== -1) return; // уже обработан выше
      if (removeByUrl(u)) {
        notify('Удалён нерабочий плагин: ' + nameFromUrl(u));
      }
    });

    log('удалено плагинов:', removed);

    topUpQuotas(deadMap);
  }

  function fixByProbe() {
    var urls = currentUrls().filter(function (u) { return !isSelf(u) && !isLocal(u); });
    var i = 0;

    (function next() {
      if (i >= urls.length) {
        topUpQuotas(null);
        ensureJacredSettings();
        return;
      }
      var u = urls[i++];

      // Явно плохие URL не проверяем сетью — удаляем сразу.
      if (isBadUrl(u) && !isTrustedHost(u)) {
        if (removeByUrl(u)) notify('Удалён нерабочий плагин: ' + nameFromUrl(u));
        next();
        return;
      }

      log('probe', u);

      probe(u, function (alive) {
        if (alive) {
          next();
          return;
        }
        removeByUrl(u);
        notify('Удалён нерабочий плагин: ' + nameFromUrl(u));
        next();
      });
    })();
  }

  // Подтягиваем замены по ВСЕМ категориям до заполнения квот.
  function topUpQuotas(deadSet) {
    Object.keys(QUOTAS).forEach(function (cat) {
      var guard = 0;
      while (!categoryCoveredWorking(cat, deadSet) && guard < WHITELIST.length) {
        guard++;
        var rep = replacementFor(cat, deadSet);
        if (!rep) break;
        install(rep, deadSet);
        if (currentUrls().indexOf(rep.url) === -1) break; // не удалось поставить — выходим
      }
    });
    ensureBaseSet(deadSet);
  }

  // Базовый набор: ставим при КАЖДОМ запуске, если категория не покрыта
  // рабочим плагином. Флаг INIT_FLAG НЕ блокирует установку — иначе после
  // первого (возможно неудачного) запуска замены не ставились бы.
  function ensureBaseSet(deadSet) {
    for (var i = 0; i < BASE_SET.length; i++) {
      var b = BASE_SET[i];
      if (currentUrls().indexOf(b.url) !== -1) continue;
      if (categoryCoveredWorking(b.category, deadSet)) continue;
      install(b, deadSet);
    }

    try {
      if (window.Lampa && Lampa.Storage && Lampa.Storage.set) {
        Lampa.Storage.set(INIT_FLAG, true);
      }
    } catch (e) {}
  }

  // ==================================================================
  // ЗАПУСК: ждём готовности Lampa и заполнения списка плагинов
  // ==================================================================
  function start() {
    var tries = 0;

    (function step() {
      tries++;

      var ready = !!(window.Lampa && Lampa.Storage && Lampa.Noty && Lampa.Plugins);
      var canFix = ready && lampaReady();

      if (tries % 10 === 0 || canFix) {
        log('wait (tries=' + tries + ', ready=' + ready +
            ', canFix=' + canFix + ')');
      }

      if (canFix) {
        log('start ok (tries=' + tries + ')');
        notify('Менеджер плагинов активен: проверяю плагины…');
        runFix();
        return;
      }

      if (tries > MAX_WAIT) {
        log('timeout (ready=' + ready + ')');
        runFix();
        return;
      }

      setTimeout(step, 100);
    })();
  }

  // Запускает проверку и повторяет её ещё пару раз, потому что _noload
  // в форке наполняется асинхронно по мере ошибок загрузки.
  function runFix() {
    var passes = 0;
    function once() {
      passes++;
      try {
        if (window.Lampa && Lampa.Plugins) fixFromLampa();
        else fixByProbe();
        ensureJacredSettings();
      } catch (e) {
        log('runFix error (pass ' + passes + ')', e);
      }
      if (passes < 3) setTimeout(once, 4000);
    }
    once();
  }

  // Запуск: если DOM уже готов — сразу, иначе по событию.
  function boot() {
    log('boot ' + APM_TOKEN);
    try { start(); } catch (e) { log('start error', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
