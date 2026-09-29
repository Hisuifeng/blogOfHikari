/* ==========================================================
   post.js — 文章页交互
   阅读进度条 / 目录高亮 / 移动端目录抽屉
   ========================================================== */
(function () {
	'use strict';

	/* ---------- 阅读进度条 ---------- */
	var bar = document.getElementById('read-progress-bar');
	var content = document.querySelector('.post-content');

	if (bar && content) {
		var ticking = false;

		function updateProgress() {
			var rect = content.getBoundingClientRect();
			var navH = 56;
			var total = content.offsetHeight - window.innerHeight + navH;
			var scrolled = -rect.top + navH;
			var pct = total > 0 ? (scrolled / total) * 100 : (rect.top <= navH ? 100 : 0);
			bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
			ticking = false;
		}

		window.addEventListener('scroll', function () {
			if (!ticking) {
				window.requestAnimationFrame(updateProgress);
				ticking = true;
			}
		}, { passive: true });

		window.addEventListener('resize', updateProgress);
		updateProgress();
	}

	/* ---------- 代码块：按行拆分，好让长行自动折行 ----------
	   目标：长代码行折行显示，不再靠横向滚动。

	   为什么不能只写 white-space: pre-wrap：
	   prism 自带的行号栏（.line-numbers-rows）是绝对定位的一列数字，
	   它假定「一个源码行 = 一个视觉行」。一旦折行，数字就整体错位，
   而且 375px 宽的手机上几乎每行都会折，错位最严重。

	   所以把每个源码行包成独立的块级元素，行号改用 CSS 计数器
	   （见 code.css 里 .code-line::before）。折行只发生在行内，
	   行与行之间仍是块级，计数器逐行递增，行号就始终对得上。

	   _config.yml 里 preprocess: true，着色是服务端做的，页面里没有 prism.js
	   在客户端重绘，所以拆完就是最终形态，不会被覆盖。 */
	function splitCodeLines(code) {
		if (code.querySelector('.code-line')) return true;

		/* highlight.js 链路已经把每行包在 .line 里，块级结构现成的，不用拆 */
		if (code.querySelector('.line')) return true;

		if (!code.textContent || !code.textContent.trim()) return false;

		var rows = code.querySelector('.line-numbers-rows');
		if (rows) rows.parentNode.removeChild(rows);

		var lines = [document.createDocumentFragment()];

		Array.prototype.slice.call(code.childNodes).forEach(function (node) {
			if (node.nodeType === 3) {
				/* 文本节点按换行切开 */
				node.nodeValue.split('\n').forEach(function (part, idx) {
					if (idx > 0) lines.push(document.createDocumentFragment());
					if (part) lines[lines.length - 1].appendChild(document.createTextNode(part));
				});
			} else if (node.nodeType === 1) {
				/* prism 的 token 元素不跨行，整块归入当前行。
				   必须整块搬而不是转成文本，否则高亮配色全丢。 */
				lines[lines.length - 1].appendChild(node);
			}
		});

		/* 去掉末尾的空行（源码结尾的换行会多切出一个空行） */
		while (lines.length > 1 && lines[lines.length - 1].textContent === '') lines.pop();

		code.textContent = '';
		lines.forEach(function (frag) {
			var span = document.createElement('span');
			span.className = 'code-line';
			span.appendChild(frag);
			code.appendChild(span);
		});

		return true;
	}

	Array.prototype.slice.call(document.querySelectorAll('.post-content pre, .rich pre')).forEach(function (pre) {
		var code = pre.querySelector('code');
		if (code && splitCodeLines(code)) pre.classList.add('code-wrap');
	});

	/* ---------- 代码块语言标识 ----------
	   高亮器会把语言写进 class：prism 是 language-xxx（pre 和 code 上都有），
	   highlight.js 是 code.language-xxx。语言名只在 class 里，正文里看不到，
	   读者要读一段代码时得往上看才知道这是 shell 还是 css。
	   这里从 class 反解出语言名，插一个 .code-lang 角标。

	   查 pre 自己的 class 是必要的：hexo 的 highlight.js 链路会把 class
	   放在 figure.highlight 上，pre 自身没有语言信息。
	   匹配不到就不插 —— 无语言标记的代码块（如纯文本输出）不该显示
	   一块空白角标。 */
	document.querySelectorAll('.post-content pre, .rich pre').forEach(function (pre) {
		if (pre.querySelector('.code-lang')) return;

		var scope = pre;
		var figure = pre.closest('figure.highlight');
		if (figure) scope = figure;

		var m = /language-([\w#+.-]+)/.exec(scope.className || '') ||
			/language-([\w#+.-]+)/.exec((pre.querySelector('code') || {}).className || '');
		if (!m) return;

		var label = document.createElement('span');
		label.className = 'code-lang';
		/* textContent 而不是 innerHTML：class 来自页面 HTML，
		   万一被污染也不能被当标记解析。 */
		label.textContent = m[1].toLowerCase();
		pre.appendChild(label);
		/* 同时给 pre 挂 has-lang，让 code.css 补出顶部内边距。
		   用类而不是 :has(.code-lang)：角标是绝对定位浮在代码上方的，
		   老浏览器不认 :has() 的话 padding 会跟着一起丢，角标就压在第一行上。 */
		pre.classList.add('has-lang');
	});

	/* ---------- 目录高亮（侧栏 + 抽屉共用） ---------- */
	var tocRoots = document.querySelectorAll('.toc-content');

	if (tocRoots.length && 'IntersectionObserver' in window) {
		var links = {};
		var targets = [];

		tocRoots.forEach(function (root) {
			root.querySelectorAll('a[href^="#"]').forEach(function (a) {
				var id = decodeURIComponent(a.getAttribute('href').slice(1));
				if (!id) return;
				(links[id] = links[id] || []).push(a);
				var el = document.getElementById(id);
				if (el && targets.indexOf(el) === -1) targets.push(el);
			});
		});

		if (targets.length) {
			var visible = new Set();

			var observer = new IntersectionObserver(function (entries) {
				entries.forEach(function (entry) {
					var id = entry.target.id;
					if (entry.isIntersecting) {
						visible.add(id);
					} else {
						visible.delete(id);
					}
				});

				var activeId = null;
				if (visible.size) {
					// 取文档顺序中最靠前的一个
					targets.some(function (el) {
						if (visible.has(el.id)) { activeId = el.id; return true; }
						return false;
					});
				}

				tocRoots.forEach(function (root) {
					root.querySelectorAll('a.active').forEach(function (a) {
						a.classList.remove('active');
					});
				});

				if (activeId && links[activeId]) {
					links[activeId].forEach(function (a) { a.classList.add('active'); });
				}
			}, { rootMargin: '-56px 0px -70% 0px', threshold: 0 });

			targets.forEach(function (el) { observer.observe(el); });
		}
	}

	/* ---------- 移动端目录抽屉 ---------- */
	var toggle = document.getElementById('toc-toggle');
	var drawer = document.getElementById('toc-drawer');
	var closeBtn = document.getElementById('toc-drawer-close');
	var mask = document.getElementById('toc-drawer-mask');

	if (toggle && drawer) {
		function setDrawer(open) {
			drawer.classList.toggle('active', open);
			toggle.setAttribute('aria-expanded', String(open));
			document.body.style.overflow = open ? 'hidden' : '';
		}

		toggle.addEventListener('click', function () {
			setDrawer(!drawer.classList.contains('active'));
		});

		if (closeBtn) closeBtn.addEventListener('click', function () { setDrawer(false); });
		if (mask) mask.addEventListener('click', function () { setDrawer(false); });

		drawer.addEventListener('click', function (e) {
			if (e.target.closest('.toc-content a')) setDrawer(false);
		});

		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && drawer.classList.contains('active')) setDrawer(false);
		});

		window.addEventListener('resize', function () {
			if (window.innerWidth > 900) setDrawer(false);
		});
	}
})();
