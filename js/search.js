/* ==========================================================
   search.js — 站内搜索
   读取 hexo-generator-search 生成的索引（默认 /search.xml）
   原生 fetch + DOMParser，无第三方依赖

   索引结构（hexo-generator-search）：
     <entry>
       <title>标题</title>
       <link href="/2026/01/03/slug/"/>   <- URL 在属性里，不是文本节点
       <url>/2026/01/03/slug/</url>       <- 部分版本用 url 文本
       <content type="html"><![CDATA[...]]></content>
       <tags><tag>标签</tag></tags>
     </entry>
   ========================================================== */
(function () {
	'use strict';

	var box = document.getElementById('search-box');
	var input = document.getElementById('search-input');
	var clearBtn = document.getElementById('search-clear');
	var status = document.getElementById('search-status');
	var results = document.getElementById('search-results');

	if (!box || !input || !status || !results) return;

	var indexUrl = box.getAttribute('data-index') || '/search.xml';
	var maxResults = parseInt(box.getAttribute('data-max'), 10) || 50;
	var index = null;
	var loading = false;
	var failed = false;

	function text(node) {
		return (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
	}

	function escapeHtml(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function escapeReg(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	// search.xml 里的 link@href 通常已经被 Hexo URL 编码过一次（中文变 %E4%BA%A1…），
	// 再套一层 encodeURI 就会变成 %25E4%25BA%25A1，点进去必然 404。
	// decodeURI 不会动 %2F %3F 这类保留字符，所以「解码再编码」是安全的幂等操作。
	// 遇到裸 % 等非法序列时 decodeURI 会抛错，直接原样返回。
	function safeHref(u) {
		try {
			return encodeURI(decodeURI(u));
		} catch (e) {
			return u;
		}
	}

	function highlight(str, kw) {
		return escapeHtml(str).replace(new RegExp('(' + escapeReg(kw) + ')', 'gi'), '<mark>$1</mark>');
	}

	/* 从链接里取日期：/2026/01/03/slug/ -> 2026-01-03 */
	function dateOf(link, fallback) {
		var m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(link || '');
		if (m) return m[1] + '-' + m[2] + '-' + m[3];
		return (fallback || '').substring(0, 10);
	}

	function parseEntry(n) {
		var linkNode = n.querySelector('link');
		var link = '';
		if (linkNode) link = linkNode.getAttribute('href') || text(linkNode);
		if (!link) link = text(n.querySelector('url'));

		var tags = [];
		Array.prototype.forEach.call(n.querySelectorAll('tags tag, category'), function (t) {
			var v = text(t);
			if (v) tags.push(v);
		});

		return {
			title: text(n.querySelector('title')) || '(无标题)',
			link: link,
			body: text(n.querySelector('content')) || text(n.querySelector('description')),
			date: dateOf(link, text(n.querySelector('pubDate')) || text(n.querySelector('updated'))),
			tags: tags
		};
	}

	function loadIndex() {
		if (index || failed || loading) return Promise.resolve(index);
		loading = true;

		return fetch(indexUrl, { credentials: 'same-origin' })
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.text();
			})
			.then(function (raw) {
				var doc = new DOMParser().parseFromString(raw, 'text/xml');
				if (doc.querySelector('parsererror')) throw new Error('XML 解析失败');

				index = Array.prototype.map.call(
					doc.querySelectorAll('entry, item'), parseEntry
				).filter(function (it) { return it.link; });

				loading = false;
				return index;
			})
			.catch(function () {
				loading = false;
				failed = true;
				status.innerHTML = '未找到可用的搜索索引 <code>' + escapeHtml(indexUrl) +
					'</code>。请在站点根目录安装并启用 <code>hexo-generator-search</code>。';
				return null;
			});
	}

	function excerpt(item, kw) {
		var body = item.body;
		if (!body) return '';
		var pos = body.toLowerCase().indexOf(kw.toLowerCase());
		if (pos < 0) return escapeHtml(body.substring(0, 110)) + (body.length > 110 ? '…' : '');
		var from = Math.max(0, pos - 45);
		var slice = body.substring(from, from + 150);
		return (from > 0 ? '…' : '') + highlight(slice, kw) + (from + 150 < body.length ? '…' : '');
	}

	function render(list, kw) {
		results.innerHTML = '';

		if (!list.length) {
			results.hidden = true;
			status.innerHTML = '没有找到与 <b>' + escapeHtml(kw) + '</b> 相关的文章。';
			return;
		}

		list.forEach(function (item) {
			var li = document.createElement('li');
			li.className = 'post-item';

			var meta = '';
			if (item.date) meta += '<time>' + escapeHtml(item.date) + '</time>';

			var tagsHtml = '';
			if (item.tags.length) {
				tagsHtml = '<p class="post-item-tags">' + item.tags.map(function (t) {
					return '<span class="chip">#' + escapeHtml(t) + '</span>';
				}).join('') + '</p>';
			}

			li.innerHTML =
				'<div class="post-item-main">' +
				'<h2 class="post-item-title"><a href="' + safeHref(item.link) + '">' +
				highlight(item.title, kw) + '</a></h2>' +
				(meta ? '<p class="post-item-meta">' + meta + '</p>' : '') +
				'<p class="post-item-digest">' + excerpt(item, kw) + '</p>' +
				tagsHtml +
				'</div>';

			results.appendChild(li);
		});

		results.hidden = false;
		status.innerHTML = '找到 <b>' + list.length + '</b> 条与 <b>' + escapeHtml(kw) + '</b> 相关的结果。';
	}

	function search(kw) {
		kw = (kw || '').trim();

		if (!kw) {
			results.hidden = true;
			results.innerHTML = '';
			status.textContent = index
				? '共 ' + index.length + ' 篇文章已建立索引，输入关键词开始搜索。'
				: '正在加载索引…';
			return;
		}

		loadIndex().then(function (data) {
			if (!data) return;

			var lower = kw.toLowerCase();
			var hits = data.filter(function (it) {
				return (it.title + ' ' + it.body + ' ' + it.tags.join(' '))
					.toLowerCase().indexOf(lower) > -1;
			});

			// 标题命中优先
			hits.sort(function (a, b) {
				var at = a.title.toLowerCase().indexOf(lower) > -1 ? 0 : 1;
				var bt = b.title.toLowerCase().indexOf(lower) > -1 ? 0 : 1;
				return at - bt;
			});

			render(hits.slice(0, maxResults), kw);
		});
	}

	/* ---------- 事件 ---------- */
	var debounce;

	input.addEventListener('input', function () {
		clearBtn.classList.toggle('show', input.value.length > 0);
		clearTimeout(debounce);
		debounce = setTimeout(function () { search(input.value); }, 180);
	});

	input.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			clearTimeout(debounce);
			search(input.value);
		} else if (e.key === 'Escape') {
			input.value = '';
			clearBtn.classList.remove('show');
			search('');
		}
	});

	clearBtn.addEventListener('click', function () {
		input.value = '';
		clearBtn.classList.remove('show');
		search('');
		input.focus();
	});

	/* ---------- 支持 ?q= 直达 ---------- */
	var preset = new URLSearchParams(location.search).get('q');
	if (preset) {
		input.value = preset;
		clearBtn.classList.add('show');
	}

	loadIndex().then(function (data) {
		if (data) {
			status.textContent = '共 ' + data.length + ' 篇文章已建立索引，输入关键词开始搜索。';
			if (input.value) search(input.value);
		}
	});
})();
