/**
 * 插件商店前端（第三期）
 * 独立 SPA：浏览 / 详情 / 提交 / 我的 / 审核，连 `/store/api`，登录走 `/store/auth`。
 * 未配置 PassPort 时即可浏览；登录/提交/评分按服务端返回的「未配置」提示降级。
 */
(function () {
  'use strict';

  var API = '/store/api';
  var AUTH = '/store/auth';

  var me = { loggedIn: false, user: null, config: { configured: false } };
  var viewBox = document.getElementById('store-view');

  function t(key) { return window.t ? window.t(key) : key; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toISOString().slice(0, 10);
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    var res = await fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: text }; }
    if (!res.ok) {
      var err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.code = data && data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setBanner(kind, msg) {
    var el = document.getElementById('storeBanner');
    if (!msg) { el.style.display = 'none'; el.className = 'store-banner'; return; }
    el.className = 'store-banner store-banner--' + (kind || 'warn');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function updateNav() {
    var submit = document.getElementById('navSubmit');
    var mine = document.getElementById('navMine');
    var admin = document.getElementById('navAdmin');
    var userBox = document.getElementById('storeUserBox');
    var loginBtn = document.getElementById('storeLoginBtn');
    var logoutBtn = document.getElementById('storeLogoutBtn');
    if (me.loggedIn) {
      userBox.style.display = 'inline';
      userBox.textContent = (me.user.username) + (me.user.admin ? ' · admin' : '') + (me.user.avatar ? ' · ' : '');
      loginBtn.style.display = 'none';
      logoutBtn.style.display = 'inline';
      mine.style.display = 'inline';
      if (me.user.admin) admin.style.display = 'inline';
    }
    if (!me.config.configured) {
      setBanner('warn', t('PassPort 尚未配置：可浏览商店，登录 / 提交 / 评分暂不可用'));
    }
  }

  function login() {
    var returnTo = (location.pathname + location.search + location.hash) || '/store';
    window.location.href = AUTH + '/login?return_to=' + encodeURIComponent(returnTo);
  }

  function base64UrlJson(value) {
    return btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function openHelperLoginTargets() {
    var params = new URLSearchParams(location.search);
    var nonce = params.get('state') || '';
    var redirectUri = params.get('redirect_uri') || '';
    var clientId = params.get('client_id') || '';
    var scope = params.get('scope') || '';
    var challenge = params.get('code_challenge') || '';
    var challengeMethod = params.get('code_challenge_method') || 'S256';
    if (!nonce || !redirectUri || !clientId || !challenge) {
      setBanner('err', t('登录参数不完整，请回终端重试'));
      return;
    }
    if (!me.loggedIn) {
      api('/me').then(function (data) {
        me = data;
        if (!me.loggedIn) {
          setBanner('warn', t('请先登录官方商店，再选择 CrewRouter'));
          login();
          return null;
        }
        return api('/install-targets');
      }).then(function (data) {
        if (data) renderHelperLoginTargets(data, nonce, redirectUri, clientId, scope, challenge, challengeMethod);
      }).catch(function (e) { setBanner('err', e.message || t('加载登录过的 CrewRouter 失败')); });
      return;
    }
    renderHelperLoginTargets(null, nonce, redirectUri, clientId, scope, challenge, challengeMethod);
  }

  function renderHelperLoginTargets(initial, nonce, redirectUri, clientId, scope, challenge, challengeMethod) {
    var targetPromise = initial ? Promise.resolve(initial) : api('/install-targets');
    targetPromise.then(function (data) {
      var targets = data.targets || [];
      var html = '<div class="store-modal-mask" id="storeHelperLoginMask"><div class="store-modal">';
      html += '<div class="store-modal__head"><h3>' + esc(t('选择要登录的 CrewRouter')) + '</h3></div>';
      html += '<p style="color:var(--muted-foreground);font-size:13px;margin:0 0 14px;">' + esc(t('请选择你要登录的 CrewRouter，登录完成后会回到终端。')) + '</p>';
      if (!targets.length) {
        html += '<div class="store-empty">' + esc(t('未检测到你登录过的 CrewRouter')) + '</div>';
      } else {
        html += '<div class="store-modal__list">' + targets.map(function (tg) {
          var targetState = base64UrlJson({ nonce: nonce, router_url: 'https://' + tg.domain });
          var url = 'https://' + tg.domain + '/oauth/authorize?' + new URLSearchParams({
            client_id: clientId, response_type: 'code', scope: scope,
            redirect_uri: redirectUri, state: targetState,
            code_challenge: challenge, code_challenge_method: challengeMethod
          }).toString();
          return '<a class="store-target store-target--ok" href="' + esc(url) + '">' +
            '<div class="store-target__domain">' + esc(tg.domain) + '</div>' +
            '<div class="store-target__meta">' + esc(fmtDate(tg.lastLogin)) + ' · ' + esc(String(tg.logins)) + ' ' + esc(t('次登录')) + '</div>' +
          '</a>';
        }).join('') + '</div>';
      }
      html += '</div></div>';
      var wrap = document.createElement('div');
      wrap.innerHTML = html;
      document.body.appendChild(wrap.firstChild);
      var mask = document.getElementById('storeHelperLoginMask');
      if (!targets.length) setBanner('warn', t('未检测到你登录过的 CrewRouter，请先在某个 CrewRouter 登录一次。'));
      if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    }).catch(function (e) {
      setBanner('err', e.message || t('加载登录过的 CrewRouter 失败'));
    });
  }

  function starHtml(score) {
    var cls = ['', 'store-stars'];
    var html = '<span class="' + cls[1] + '">';
    for (var i = 1; i <= 5; i++) {
      var on = i <= score ? ' on' : '';
      html += '<span class="star' + on + '">★</span>';
    }
    html += '</span>';
    return html;
  }

  function starPicker(initial, onPick) {
    var html = '<span class="store-stars" data-star-picker="1">';
    for (var i = 1; i <= 5; i++) {
      html += '<span class="star' + (i <= initial ? ' on' : '') + '" data-star="' + i + '">★</span>';
    }
    html += '</span>';
    return html;
  }

  function pickerInit(container, onPick) {
    var root = container.querySelector('[data-star-picker]');
    if (!root) return;
    var starsEls = root.querySelectorAll('.star');
    function highlight(n) {
      starsEls.forEach(function (el) { el.classList.toggle('on', Number(el.dataset.star) <= n); });
    }
    starsEls.forEach(function (el) {
      el.addEventListener('click', function () {
        var n = Number(el.dataset.star);
        highlight(n);
        if (onPick) onPick(n);
      });
      el.addEventListener('mouseenter', function () { highlight(Number(el.dataset.star)); });
    });
    root.addEventListener('mouseleave', function () {
      var cur = root.dataset.value ? Number(root.dataset.value) : 0;
      highlight(cur);
    });
    root.dataset.value = String(initial || 0);
  }

  function tagChips(tags) {
    return (tags || []).map(function (x) {
      return '<span class="btn btn-sm btn-secondary" style="cursor:pointer" data-tag="' + esc(x) + '">' + esc(x) + '</span>';
    }).join('');
  }

  function cardHtml(p) {
    var rating = p.ratingCount ? ((p.ratingAvg || 0).toFixed(1) + ' (' + p.ratingCount + ')') : t('暂无评分');
    return (
      '<article class="store-card">' +
        '<div class="store-card__cover">' + (p.icon ? '<img src="' + esc(p.icon) + '" alt="" style="width:64px;height:64px;border-radius:12px;object-fit:cover;">' : '🧩') + '</div>' +
        '<div class="store-card__body">' +
          '<div class="store-card__name">' + esc(p.name) + '</div>' +
          '<div class="store-card__desc">' + esc(p.description || '') + '</div>' +
          '<div class="store-card__tags">' + tagChips(p.tags.slice(0, 3)) + '</div>' +
          '<div class="store-card__meta"><span>v' + esc(p.version) + '</span><span>' + esc(p.authorUsername || p.author) + '</span><span>' + rating + '</span></div>' +
          '<div class="store-card__actions"><a class="btn btn-primary btn-sm" href="/store#/plugin/' + encodeURIComponent(p.id) + '">' + t('详情') + '</a></div>' +
        '</div>' +
      '</article>'
    );
  }

  function runQuery(refresh) {
    var q = (document.getElementById('storeSearch') || {}).value || '';
    var sort = document.getElementById('storeSort').value;
    var tag = (document.querySelector('[data-active-tag]') || {}).dataset ? (document.querySelector('[data-active-tag]').dataset.activeTag || '') : '';
    var params = new URLSearchParams({ public: '1' });
    if (q.trim()) params.set('q', q.trim());
    if (sort) params.set('sort', sort);
    if (tag) params.set('tag', tag);
    api('/plugins?' + params.toString()).then(function (data) {
      renderListResult(data.plugins, q, tag, sort);
    }).catch(function (e) {
      setBanner('err', e.message);
      viewBox.innerHTML = '<div class="store-error">' + esc(e.message || t('加载失败')) + '</div>';
    });
  }

  function renderListResult(plugins, q, tag, sort) {
    var html = '';
    html += '<div class="store-toolbar">' +
      '<input type="search" id="storeSearch" placeholder="' + esc(t('搜索插件、作者、标签...')) + '" value="' + esc(q) + '">' +
      '<select id="storeSort" class="btn btn-sm">' +
        '<option value="updated"' + (sort === 'updated' || !sort ? ' selected' : '') + '>' + esc(t('最新更新')) + '</option>' +
        '<option value="rating"' + (sort === 'rating' ? ' selected' : '') + '>' + esc(t('评分最高')) + '</option>' +
        '<option value="installs"' + (sort === 'installs' ? ' selected' : '') + '>' + esc(t('安装最多')) + '</option>' +
      '</select>' +
      '<button class="btn btn-sm btn-primary" id="storeSearchBtn">' + esc(t('搜索')) + '</button>' +
      (tag ? '<button class="btn btn-sm btn-secondary" data-active-tag="' + esc(tag) + '">#' + esc(tag) + ' ×</button>' : '') +
    '</div>';

    if (!plugins.length) {
      html += '<div class="store-empty">' + esc(t('暂无插件')) + '</div>';
    } else {
      html += '<div class="store-grid">' + plugins.map(cardHtml).join('') + '</div>';
    }
    viewBox.innerHTML = html;

    document.getElementById('storeSearch').addEventListener('keydown', function (e) { if (e.key === 'Enter') runQuery(); });
    document.getElementById('storeSearchBtn').addEventListener('click', runQuery);
    document.getElementById('storeSort').addEventListener('change', runQuery);
    viewBox.querySelectorAll('[data-tag]').forEach(function (el) {
      el.addEventListener('click', function () {
        document.getElementById('storeSearch').value = '';
        renderListResult(plugins, '', el.dataset.tag, sort);
      });
    });
    viewBox.querySelectorAll('[data-active-tag]').forEach(function (el) {
      el.addEventListener('click', function () { renderListResult(plugins, '', '', sort); });
    });
  }

  function viewList() {
    api('/plugins?public=1').then(function (data) {
      renderListResult(data.plugins, '', '', 'updated');
    }).catch(function (e) {
      setBanner('err', e.message);
      viewBox.innerHTML = '<div class="store-error">' + esc(e.message || t('加载失败')) + '</div>';
    });
  }

  function installHandler(id, btn) {
    btn.disabled = true;
    api('/plugins/' + encodeURIComponent(id) + '/install-link').then(function (data) {
      api('/plugins/' + encodeURIComponent(id) + '/install-click').catch(function () {});
      if (data.install_url) {
        window.location.href = data.install_url;
        setBanner('ok', t('已生成安装链接：') + ' ' + data.install_url);
      }
    }).catch(function (e) {
      setBanner('err', e.message);
    }).finally(function () { btn.disabled = false; });
  }

  function ratingListHtml(ratings) {
    if (!ratings || !ratings.length) return '<div class="store-empty" style="padding:20px;">' + esc(t('暂无评分')) + '</div>';
    return ratings.map(function (r) {
      var replies = (r.replies || []).map(function (rp) {
        return '<div class="store-rating-item" style="margin:8px 0 0; "><div class="store-rating-item__head"><strong>' + esc(rp.username) + '</strong><span>' + esc(fmtDate(rp.createdAt)) + '</span></div><div>' + esc(rp.body) + '</div></div>';
      }).join('');
      return '<div class="store-rating-item">' +
        '<div class="store-rating-item__head"><strong>' + esc(r.username) + '</strong>' + starHtml(r.stars) + '<span>' + esc(fmtDate(r.updatedAt || r.createdAt)) + '</span></div>' +
        (r.comment ? '<div style="margin-top:6px;">' + esc(r.comment) + '</div>' : '') +
        (replies ? '<div style="margin-top:8px;">' + replies + '</div>' : '') +
        '<div style="margin-top:8px;"><button class="btn btn-sm btn-secondary" data-reply-user="' + esc(r.username) + '">' + esc(t('回复')) + '</button></div>' +
      '</div>';
    }).join('');
  }

  function viewDetail(id) {
    api('/plugins/' + encodeURIComponent(id) + '?include=related&related=1').then(function (data) {
      var p = data.plugin;
      var html = '';
      if (p.myRating) {
        html += '<div class="store-banner store-banner--ok">' + esc(t('我的评分：')) + ' ' + p.myRating.stars + '★</div>';
      }
      html += '<a class="back-link" href="/store" style="display:inline-flex;gap:6px;margin:16px 0;color:var(--muted-foreground);text-decoration:none;">← ' + esc(t('返回商店')) + '</a>';
      html += '<div class="store-detail__head">' +
        '<div class="store-detail__icon">' + (p.icon ? '<img src="' + esc(p.icon) + '" style="width:72px;height:72px;border-radius:16px;object-fit:cover;">' : '🧩') + '</div>' +
        '<div><div class="store-detail__title">' + esc(p.name) + '</div>' +
        '<div class="store-detail__byline">v' + esc(p.version) + ' · ' + esc(p.authorUsername || p.author) + '</div>' +
        '<div class="store-detail__stats"><span>' + esc(t('安装')) + ' ' + (p.installCount || 0) + '</span><span>' + esc(t('评分')) + ' ' + (p.ratingCount || 0) + '</span></div>' +
        '</div></div>';
      html += '<div class="store-detail__body">' +
        '<div class="store-detail__left">' +
          '<div class="store-detail__section"><h3>' + esc(t('简介')) + '</h3><div>' + esc(p.longDescription || p.description || '') + '</div></div>' +
          (p.screenshots && p.screenshots.length ? '<div class="store-detail__section"><h3>' + esc(t('截图')) + '</h3><div class="store-shots">' + p.screenshots.map(function (s) { return '<img src="' + esc(s.url) + '" alt="">'; }).join('') + '</div></div>' : '') +
          '<div class="store-detail__section"><h3>' + esc(t('权限')) + '</h3><div class="store-related">' + tagChips(p.permissions) + '</div></div>' +
          '<div class="store-detail__section"><h3>' + esc(t('评分')) + '</h3>' + ratingListHtml([]) + '</div>' +
        '</div>' +
        '<div class="store-detail__side">' +
          '<div class="store-card" style="display:block;">' +
            '<div class="store-card__body">' +
              '<div class="store-card__meta"><span>' + esc(t('标签')) + '</span></div>' +
              '<div class="store-card__tags">' + tagChips(p.tags) + '</div>' +
              '<div class="store-card__actions"><button class="btn btn-primary" id="installBtn">' + esc(t('安装')) + '</button>' +
                '<button class="btn btn-secondary" id="installToRouterBtn">' + esc(t('安装到 CrewRouter')) + '</button></div>' +
            '</div>' +
          '</div>' +
          '<div id="ratingBox"></div>' +
        '</div>' +
      '</div>';

      if (p.related && p.related.length) {
        html += '<div class="store-detail__section" style="margin-top:24px;"><h3>' + esc(t('相关插件')) + '</h3><div class="store-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));">' + p.related.slice(0, 6).map(cardHtml).join('') + '</div></div>';
      }

      viewBox.innerHTML = html;
      var installBtn = document.getElementById('installBtn');
      if (installBtn) installBtn.addEventListener('click', function () { installHandler(p.id, installBtn); });
      var installRouterBtn = document.getElementById('installToRouterBtn');
      if (installRouterBtn) installRouterBtn.addEventListener('click', function () { openInstallTargetsModal(p.id); });

      // 评分区：需要登录且已配置
      var box = document.getElementById('ratingBox');
      if (me.loggedIn && me.config.configured) {
        box.innerHTML = '<div class="store-detail__section"><h3>' + esc(t('我要评分')) + '</h3>' +
          starPicker(p.myRating ? p.myRating.stars : 0, function () {}) +
          '<textarea id="ratingComment" placeholder="' + esc(t('写下你的评价（可选，最多 500 字）')) + '" style="width:100%;margin-top:8px;min-height:60px;"></textarea>' +
          '<div style="margin-top:8px;display:flex;gap:8px;"><button class="btn btn-sm btn-primary" id="ratingSubmitBtn">' + esc(t('提交评分')) + '</button>' +
          (p.myRating ? '<button class="btn btn-sm btn-secondary" id="ratingDeleteBtn">' + esc(t('删除评分')) + '</button>' : '') + '</div></div>';
        var picked = p.myRating ? p.myRating.stars : 0;
        var root = box.querySelector('[data-star-picker]');
        pickerInit(box, function (n) { picked = root.dataset.value = n; root.dataset.value = String(n); });
        box.querySelector('#ratingSubmitBtn').addEventListener('click', function () {
          if (!picked) { setBanner('warn', t('请选择星级')); return; }
          api('/plugins/' + encodeURIComponent(p.id) + '/ratings', { method: 'PUT', body: { stars: picked, comment: box.querySelector('#ratingComment').value } }).then(function () {
            setBanner('ok', t('评分已保存'));
            viewDetail(p.id);
          }).catch(function (e) { setBanner('err', e.message); });
        });
        var del = box.querySelector('#ratingDeleteBtn');
        if (del) del.addEventListener('click', function () {
          api('/plugins/' + encodeURIComponent(p.id) + '/ratings', { method: 'DELETE' }).then(function () {
            setBanner('ok', t('评分已删除'));
            viewDetail(p.id);
          }).catch(function (e) { setBanner('err', e.message); });
        });
        box.querySelectorAll('[data-reply-user]').forEach(function (el) {
          el.addEventListener('click', function () {
            var u = el.dataset.replyUser;
            var c = window.prompt(t('回复') + ' ' + u + ':', '');
            if (c == null) return;
            api('/plugins/' + encodeURIComponent(p.id) + '/ratings/' + encodeURIComponent(u) + '/replies', { method: 'POST', body: { body: c } }).then(function () {
              setBanner('ok', t('回复已发布'));
              viewDetail(p.id);
            }).catch(function (e) { setBanner('err', e.message); });
          });
        });
      } else if (!me.config.configured) {
        box.innerHTML = '<div class="store-empty" style="padding:16px;">' + esc(t('PassPort 未配置，暂不能评分')) + '</div>';
      } else {
        box.innerHTML = '<div class="store-empty" style="padding:16px;"><a class="btn btn-sm btn-secondary" href="' + AUTH + '/login?return_to=' + encodeURIComponent(location.pathname + location.hash) + '">' + esc(t('登录后评分')) + '</a></div>';
      }

      loadRatingsInto(p.id);
    }).catch(function (e) {
      setBanner('err', e.message);
      viewBox.innerHTML = '<div class="store-error">' + esc(e.message || t('加载失败')) + '</div>';
    });
  }

  function loadRatingsInto(id) {
    api('/plugins/' + encodeURIComponent(id) + '/ratings?limit=20').then(function (data) {
      var el = viewBox.querySelector('.store-detail__section h3');
      // 更新左栏「评分」区块
      var secs = viewBox.querySelectorAll('.store-detail__section');
      var target = Array.prototype.find.call(secs, function (s) { return s.querySelector('h3') && s.querySelector('h3').textContent === t('评分'); });
      if (target) {
        var body = target.querySelector('h3').nextElementSibling ? null : target;
        target.innerHTML = '<h3>' + esc(t('评分')) + ' · ' + data.count + '</h3>' + ratingListHtml(data.ratings);
        wireReplies(id);
      }
      // 更新「我要评分」顶部我的评分
      if (data.myRating) {
        var banner = viewBox.querySelector('.store-banner--ok');
        if (banner) banner.textContent = t('我的评分：') + ' ' + data.myRating.stars + '★';
      }
    }).catch(function () {});
  }

  function wireReplies(id) {
    viewBox.querySelectorAll('[data-reply-user]').forEach(function (el) {
      el.addEventListener('click', function () {
        var u = el.dataset.replyUser;
        var c = window.prompt(t('回复') + ' ' + u + ':', '');
        if (c == null) return;
        api('/plugins/' + encodeURIComponent(id) + '/ratings/' + encodeURIComponent(u) + '/replies', { method: 'POST', body: { body: c } }).then(function () {
          setBanner('ok', t('回复已发布'));
          viewDetail(id);
        }).catch(function (e) { setBanner('err', e.message); });
      });
    });
  }

  function submitFormHtml(editId, draft) {
    var d = draft || {};
    var actionLabel = editId ? t('保存修改') : t('提交插件');
    return '<div class="store-form">' +
      '<div class="store-form__upload" style="border:1px dashed var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px;">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:8px;">🧩 ' + esc(t('从 plugin.json 快速填充')) + '</div>' +
        '<div class="form-group">' +
          '<label>' + esc(t('选择 plugin.json 文件')) + '</label>' +
          '<input type="file" id="manifestFile" accept=".json,application/json">' +
          '<div class="form-help">' + esc(t('或粘贴 JSON 内容')) + '</div>' +
          '<textarea id="manifestJson" style="min-height:70px;" placeholder="{\&quot;name\&quot;: \&quot;...\&quot;}"></textarea>' +
        '</div>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="manifestApply">' + esc(t('解析并填充')) + '</button>' +
      '</div>' +
      '<div class="form-group"><label>' + esc(t('插件 id（唯一，英文/数字/._-）')) + '</label><input type="text" id="f_id" value="' + esc(d.id || '') + '" ' + (editId ? 'disabled' : '') + '><div class="form-help">' + esc(t('3–128 字符，仅字母数字与 ._-')) + '</div></div>' +
      '<div class="form-group"><label>' + esc(t('插件名称')) + '</label><input type="text" id="f_name" value="' + esc(d.name || '') + '"></div>' +
      '<div class="form-group"><label>' + esc(t('版本号')) + '</label><input type="text" id="f_version" value="' + esc(d.version || '') + '"></div>' +
      '<div class="form-group"><label>' + esc(t('作者')) + '</label><input type="text" id="f_author" value="' + esc(d.author || '') + '"></div>' +
      '<div class="form-group"><label>' + esc(t('简介')) + '</label><textarea id="f_description">' + esc(d.description || '') + '</textarea></div>' +
      '<div class="form-group"><label>' + esc(t('详细描述')) + '</label><textarea id="f_long">' + esc(d.longDescription || '') + '</textarea></div>' +
      '<div class="form-group"><label>' + esc(t('下载地址（https ZIP 直链）')) + '</label><input type="text" id="f_download" value="' + esc(d.download || '') + '"></div>' +
      '<div class="form-group"><label>' + esc(t('SHA256（可选，64 位十六进制）')) + '</label><input type="text" id="f_sha256" value="' + esc(d.sha256 || '') + '"></div>' +
      '<div class="form-group"><label>' + esc(t('主页 url（可选）')) + '</label><input type="text" id="f_url" value="' + esc(d.url || '') + '"></div>' +
      '<div class="form-group"><label>' + esc(t('图标 url（可选）')) + '</label><input type="text" id="f_icon" value="' + esc(d.icon || '') + '"></div>' +
      '<div class="form-group"><label>' + esc(t('标签（逗号分隔）')) + '</label><input type="text" id="f_tags" value="' + esc((d.tags || []).join(',')) + '"></div>' +
      '<div class="form-group"><label>' + esc(t('权限（逗号分隔，如 gateway:observe, themes:register）')) + '</label><input type="text" id="f_permissions" value="' + esc((d.permissions || []).join(',')) + '"></div>' +
      '<div class="form-actions"><button class="btn btn-primary" id="submitBtn">' + esc(actionLabel) + '</button><a class="btn btn-secondary" href="/store">' + esc(t('取消')) + '</a></div>' +
    '</div>';
  }

  // 从 plugin.json 解析出可映射字段并填充到表单；返回错误文案（null 表示成功）
  function applyManifestToForm(text, editId) {
    var obj = null;
    try { obj = JSON.parse(text); } catch (e) { return t('JSON 格式无效，请检查后重试'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return t('解析失败：必须是 JSON 对象');
    function setv(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = (v == null ? '' : String(v));
    }
    if (!editId) setv('f_id', obj.id);
    setv('f_name', obj.name);
    setv('f_version', obj.version);
    setv('f_author', obj.author);
    setv('f_description', obj.description);
    if (Array.isArray(obj.permissions) || typeof obj.permissions === 'string') setv('f_permissions', Array.isArray(obj.permissions) ? obj.permissions.join(',') : obj.permissions);
    if (Array.isArray(obj.tags) || typeof obj.tags === 'string') setv('f_tags', Array.isArray(obj.tags) ? obj.tags.join(',') : obj.tags);
    return null;
  }

  function wireManifestUpload(editId) {
    var fileEl = document.getElementById('manifestFile');
    var textEl = document.getElementById('manifestJson');
    var btn = document.getElementById('manifestApply');
    if (!fileEl || !textEl || !btn) return;
    fileEl.addEventListener('change', function () {
      var f = fileEl.files && fileEl.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { textEl.value = String(rd.result || ''); };
      rd.readAsText(f);
    });
    btn.addEventListener('click', function () {
      var text = (textEl.value || '').trim();
      if (!text) { setBanner('warn', t('请先选择或粘贴 plugin.json')); return; }
      var err = applyManifestToForm(text, editId);
      if (err) { setBanner('err', err); return; }
      setBanner('ok', t('已从 plugin.json 填充字段，请补充下载地址等商店信息'));
    });
  }

  function viewSubmit(editId) {
    api('/me').then(function (mm) {
      me = mm;
      updateNav();
      var html = '<div class="store-detail__title" style="margin:16px 0;">' + esc(t('提交插件')) + '</div>';
      if (!me.config.configured) {
        html += '<div class="store-empty">' + esc(t('PassPort 尚未配置，无法提交插件')) + '</div>';
        viewBox.innerHTML = html;
        return;
      }
      if (!me.loggedIn) {
        html += '<div class="store-empty"><a class="btn btn-primary" href="' + AUTH + '/login?return_to=' + encodeURIComponent('/store#/submit') + '">' + esc(t('登录后提交')) + '</a></div>';
        viewBox.innerHTML = html;
        return;
      }
      if (!editId) {
        viewBox.innerHTML = html + submitFormHtml();
        wireSubmitForm();
        wireManifestUpload();
        return;
      }
      api('/plugins/' + encodeURIComponent(editId)).then(function (data) {
        var p = data.plugin;
        var draft = p.pendingUpdate || p;
        viewBox.innerHTML = html + submitFormHtml(editId, draft);
        wireSubmitForm(editId, p);
        wireManifestUpload(editId);
      }).catch(function (e) {
        viewBox.innerHTML = '<div class="store-error">' + esc(e.message) + '</div>';
      });
    });
  }

  function wireSubmitForm(editId, current) {
    document.getElementById('submitBtn').addEventListener('click', function () {
      var payload = {
        name: document.getElementById('f_name').value.trim(),
        version: document.getElementById('f_version').value.trim(),
        author: document.getElementById('f_author').value.trim(),
        description: document.getElementById('f_description').value.trim(),
        longDescription: document.getElementById('f_long').value.trim(),
        download: document.getElementById('f_download').value.trim(),
        sha256: document.getElementById('f_sha256').value.trim(),
        url: document.getElementById('f_url').value.trim(),
        icon: document.getElementById('f_icon').value.trim(),
        tags: document.getElementById('f_tags').value.split(/[,，]+/).map(function (s) { return s.trim(); }).filter(Boolean),
        permissions: document.getElementById('f_permissions').value.split(/[,，]+/).map(function (s) { return s.trim(); }).filter(Boolean)
      };
      if (!editId) payload.id = document.getElementById('f_id').value.trim();
      if (!payload.name) { setBanner('warn', t('请填写插件名称')); return; }
      if (!payload.version) { setBanner('warn', t('请填写版本号')); return; }
      if (!payload.download) { setBanner('warn', t('请填写下载地址')); return; }
      var req = editId
        ? api('/plugins/' + encodeURIComponent(editId), { method: 'PATCH', body: payload })
        : api('/plugins', { method: 'POST', body: payload });
      req.then(function () {
        setBanner('ok', editId ? t('修改已保存，等待审核') : t('提交成功，等待审核'));
        location.hash = '#/mine';
        route();
      }).catch(function (e) {
        setBanner('err', e.message);
      });
    });
  }

  function viewMine() {
    api('/me').then(function (mm) {
      me = mm;
      updateNav();
      if (!me.config.configured) {
        viewBox.innerHTML = '<div class="store-empty">' + esc(t('PassPort 尚未配置，无法查看我的插件')) + '</div>';
        return;
      }
      if (!me.loggedIn) {
        viewBox.innerHTML = '<div class="store-empty"><a class="btn btn-primary" href="' + AUTH + '/login?return_to=' + encodeURIComponent('/store#/mine') + '">' + esc(t('登录后查看')) + '</a></div>';
        return;
      }
      api('/plugins?scope=mine').then(function (data) {
        var html = '<div class="store-detail__title" style="margin:16px 0;">' + esc(t('我的插件')) + '</div>';
        if (!data.plugins.length) {
          html += '<div class="store-empty">' + esc(t('还没有提交过插件')) + '</div>';
        } else {
          html += data.plugins.map(function (p) {
            var statusText = p.status === 'approved' ? t('已上架') : p.status === 'rejected' ? t('已拒绝') : t('待审核');
            var draft = p.hasPendingUpdate ? ' · ' + t('待更新审核') : '';
            var reject = p.rejectReason ? ' · ' + esc(p.rejectReason) : '';
            return '<div class="store-admin-row">' +
              '<div class="store-admin-row__meta"><div><strong>' + esc(p.name) + '</strong> <span class="btn btn-sm btn-secondary">' + esc(statusText) + '</span>' + draft + reject + '</div>' +
              '<div style="font-size:12px;color:var(--muted-foreground);margin-top:4px;">v' + esc(p.version) + ' · ' + esc(p.id) + ' · ' + esc(t('安装')) + ' ' + (p.installCount || 0) + '</div></div>' +
              '<div class="store-admin-row__actions"><a class="btn btn-sm btn-secondary" href="/store#/plugin/' + encodeURIComponent(p.id) + '">' + esc(t('查看')) + '</a>' +
                '<a class="btn btn-sm btn-primary" href="/store#/submit/' + encodeURIComponent(p.id) + '">' + esc(t('编辑')) + '</a>' +
              '</div></div>';
          }).join('');
        }
        viewBox.innerHTML = html;
      }).catch(function (e) { setBanner('err', e.message); });
    });
  }

  function viewAdmin() {
    api('/me').then(function (mm) {
      me = mm;
      updateNav();
      if (!me.config.configured) {
        viewBox.innerHTML = '<div class="store-empty">' + esc(t('PassPort 尚未配置，无法审核')) + '</div>';
        return;
      }
      if (!me.loggedIn || !me.user.admin) {
        viewBox.innerHTML = '<div class="store-empty">' + esc(t('需要管理员权限')) + '</div>';
        return;
      }
      var statusFilter = (viewAdmin.currentStatus || 'pending');
      api('/plugins?scope=admin' + (statusFilter && statusFilter !== 'all' ? '&status=' + encodeURIComponent(statusFilter) : '')).then(function (data) {
        var html = '<div class="store-detail__title" style="margin:16px 0;">' + esc(t('审核')) + '</div>';
        html += '<div class="store-toolbar">' +
          '<select id="adminStatus" class="btn btn-sm">' +
            '<option value="pending"' + (statusFilter === 'pending' ? ' selected' : '') + '>' + esc(t('待审核')) + '</option>' +
            '<option value="approved"' + (statusFilter === 'approved' ? ' selected' : '') + '>' + esc(t('已上架')) + '</option>' +
            '<option value="rejected"' + (statusFilter === 'rejected' ? ' selected' : '') + '>' + esc(t('已拒绝')) + '</option>' +
            '<option value="all"' + (statusFilter === 'all' ? ' selected' : '') + '>' + esc(t('全部')) + '</option>' +
          '</select></div>';
        if (!data.plugins.length) {
          html += '<div class="store-empty">' + esc(t('暂无插件')) + '</div>';
        } else {
          html += data.plugins.map(function (p) {
            var needsReview = p.status === 'pending' || p.hasPendingUpdate;
            var statusText = p.status === 'approved' ? t('已上架') : p.status === 'rejected' ? t('已拒绝') : t('待审核');
            return '<div class="store-admin-row">' +
              '<div class="store-admin-row__meta"><div><strong>' + esc(p.name) + '</strong> <span class="btn btn-sm btn-secondary">' + esc(statusText) + '</span> ' + (p.hasPendingUpdate ? t('待更新审核') : '') + '</div>' +
              '<div style="font-size:12px;color:var(--muted-foreground);margin-top:4px;">v' + esc(p.version) + ' · ' + esc(p.id) + ' · ' + esc(p.authorUsername || p.author) + ' · ' + esc(t('安装')) + ' ' + (p.installCount || 0) + '</div>' +
              (p.rejectReason ? '<div style="font-size:12px;color:var(--destructive);margin-top:4px;">' + esc(t('拒绝原因')) + '：' + esc(p.rejectReason) + '</div>' : '') +
              '</div>' +
              '<div class="store-admin-row__actions">' +
                '<a class="btn btn-sm btn-secondary" href="/store#/plugin/' + encodeURIComponent(p.id) + '">' + esc(t('查看')) + '</a>' +
                (needsReview ? '<button class="btn btn-sm btn-primary" data-approve="' + encodeURIComponent(p.id) + '">' + esc(t('通过')) + '</button>' +
                  '<button class="btn btn-sm btn-secondary" data-reject="' + encodeURIComponent(p.id) + '">' + esc(t('拒绝')) + '</button>' : '') +
              '</div></div>';
          }).join('');
        }
        viewBox.innerHTML = html;
        document.getElementById('adminStatus').addEventListener('change', function () {
          viewAdmin.currentStatus = this.value;
          viewAdmin();
        });
        viewBox.querySelectorAll('[data-approve]').forEach(function (el) {
          el.addEventListener('click', function () {
            api('/plugins/' + decodeURIComponent(el.dataset.approve) + '/review', { method: 'POST', body: { action: 'approve' } }).then(function () {
              setBanner('ok', t('已通过'));
              viewAdmin();
            }).catch(function (e) { setBanner('err', e.message); });
          });
        });
        viewBox.querySelectorAll('[data-reject]').forEach(function (el) {
          el.addEventListener('click', function () {
            var reason = window.prompt(t('拒绝原因：'), '');
            if (reason == null) return;
            api('/plugins/' + decodeURIComponent(el.dataset.reject) + '/review', { method: 'POST', body: { action: 'reject', reason: reason } }).then(function () {
              setBanner('ok', t('已拒绝'));
              viewAdmin();
            }).catch(function (e) { setBanner('err', e.message); });
          });
        });
      }).catch(function (e) { setBanner('err', e.message); });
    });
  }

  function permissionLabel(p) {
    var map = {
      'storage': t('读写插件私有存储'),
      'network': t('访问外部网络'),
      'gateway:modify': t('注册网关钩子（请求/响应/转发干预）'),
      'provider:register': t('注册上游格式/协议转换/供应商选择'),
      'apikey:modify': t('API Key 校验与创建钩子'),
      'billing:modify': t('调整计费/配额'),
      'cron:register': t('声明定时任务'),
      'pages:register': t('新增控制台页面/插槽'),
      'routes:register': t('挂载自有 HTTP 接口'),
      'themes:register': t('注册界面主题')
    };
    return map[p] || p;
  }

  function removeModal() {
    var mask = document.getElementById('storeInstallMask');
    if (mask) mask.remove();
  }

  function openInstallTargetsModal(pluginId) {
    api('/install-targets').then(function (data) {
      var targets = data.targets || [];
      var html = '<div class="store-modal-mask" id="storeInstallMask"><div class="store-modal">';
      html += '<div class="store-modal__head"><h3>' + esc(t('安装到 CrewRouter')) + '</h3><button class="btn btn-sm btn-secondary" id="storeModalClose">' + esc(t('关闭')) + '</button></div>';
      if (!targets.length) {
        html += '<div class="store-empty">' + esc(t('未检测到你登录过的 CrewRouter')) + '</div>';
      } else {
        html += '<div class="store-modal__list">' + targets.map(function (tg) {
          var note = tg.isAdmin ? '' : '<div class="store-target__note">' + esc(t('没有管理员权限')) + '</div>';
          var attrs = '';
          if (tg.isAdmin) {
            var url = 'https://' + tg.domain + '/plugin-install?plugin=' + encodeURIComponent(pluginId) + '&source=' + encodeURIComponent(location.origin);
            attrs = ' href="' + esc(url) + '"';
          }
          var cls = 'store-target ' + (tg.isAdmin ? 'store-target--ok' : 'store-target--disabled');
          return '<a class="' + cls + '"' + attrs + '>' +
            '<div class="store-target__domain">' + esc(tg.domain) + '</div>' +
            '<div class="store-target__meta">' + esc(fmtDate(tg.lastLogin)) + ' · ' + esc(String(tg.logins)) + ' ' + esc(t('次登录')) + '</div>' +
            note +
          '</a>';
        }).join('') + '</div>';
      }
      html += '</div></div>';

      var wrap = document.createElement('div');
      wrap.innerHTML = html;
      var mask = wrap.firstChild;
      document.body.appendChild(mask);

      var close = document.getElementById('storeModalClose');
      if (close) close.addEventListener('click', removeModal);
      mask.addEventListener('click', function (e) { if (e.target === mask) removeModal(); });
      // 非管理员实例不可点：拦截默认跳转
      mask.querySelectorAll('a.store-target--disabled').forEach(function (a) {
        a.addEventListener('click', function (e) { e.preventDefault(); });
      });
    }).catch(function (e) {
      if (e.code === 'NOT_LOGIN' || e.status === 401) {
        setBanner('warn', t('请先登录，再安装到你的 CrewRouter'));
        return;
      }
      setBanner('err', e.message);
    });
  }

  function route() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'plugin' && parts[1]) { viewDetail(decodeURIComponent(parts[1])); return; }
    if (parts[0] === 'submit') { viewSubmit(parts[1] ? decodeURIComponent(parts[1]) : null); return; }
    if (parts[0] === 'mine') { viewMine(); return; }
    if (parts[0] === 'admin') { viewAdmin(); return; }
    viewList();
  }

  function handleAuthQuery() {
    var params = new URLSearchParams(location.search);
    var a = params.get('auth');
    if (!a) return;
    var map = { ok: ['ok', t('登录成功')], denied: ['warn', t('你拒绝了授权')], error: ['err', t('登录失败，请重试')], logout: ['ok', t('已登出')], unconfigured: ['warn', t('PassPort 尚未配置：可浏览商店，登录 / 提交 / 评分暂不可用')] };
    var m = map[a];
    if (m) { setBanner(m[0], m[1]); history.replaceState(null, '', '/store' + location.hash); }
  }

  function boot() {
    if (new URLSearchParams(location.search).get('helper_login') === '1') {
      openHelperLoginTargets();
      return;
    }
    document.getElementById('storeLoginBtn').addEventListener('click', login);
    document.getElementById('storeLogoutBtn').addEventListener('click', function () {
      window.location.href = AUTH + '/logout';
    });
    window.addEventListener('hashchange', route);
    api('/me').then(function (mm) {
      me = mm;
      updateNav();
    }).catch(function () {}).finally(function () {
      handleAuthQuery();
      route();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
