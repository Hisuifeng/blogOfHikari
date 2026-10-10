/* ==========================================================================
   extras.js — 正文里的几类增强元素
   结构见 layout/post.ejs，样式见 css/extras.css，标签见 scripts/tags.js。

   两类工作要分清：
     · 事件委托（黑幕点击、复制链接）—— 只绑一次。pjax 换页会重放本脚本，
       绑在 document 上会一次比一次多。
     · 内容初始化（图片注释、GitHub 卡片、流程图、公式）—— 每次都要跑，
       因为 #content 里的节点已经换过一批了。

   #content 元素本身在 pjax 换页时不会被替换（只换 innerHTML），
   所以它不能当"绑定一次"的依据。
   ========================================================================== */
(function () {
	'use strict';

	var G = window.__restartExtras = window.__restartExtras || {};
	G.mermaidJobs = [];

	var root = document.getElementById('content') || document.body;

	/* ---------- 事件委托（只绑一次） ---------- */

	/* 复制文本：优先 Clipboard API；非 HTTPS 或旧浏览器退回临时 textarea。
	   结果交给调用方决定怎么提示 —— 分享按钮和代码按钮的文案不一样。 */
	function copyText(text, done) {
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
			return;
		}
		var ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
		document.body.appendChild(ta);
		ta.select();
		var ok = false;
		try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
		ta.remove();
		done(ok);
	}

	/* 按钮上的临时反馈：换成结果文案，1.6 秒后复原 */
	function flashLabel(btn, ok) {
		var label = btn.getAttribute('data-label') || btn.textContent;
		btn.setAttribute('data-label', label);
		btn.textContent = ok ? '已复制' : '复制失败';
		setTimeout(function () { btn.textContent = label; }, 1600);
	}

	function onDocClick(e) {
		var t = e.target;
		if (!t || !t.classList) return;

		/* 黑幕：点一下揭开，再点盖回去 */
		if (t.classList.contains('heimu')) {
			t.classList.toggle('on');
			return;
		}

		var copy = t.closest ? t.closest('[data-share="copy"]') : null;
		if (copy) {
			e.preventDefault();
			copyText(location.href, function (ok) { flashLabel(copy, ok); });
			return;
		}

		/* 代码块的复制按钮：复制的是整个 <code>，
		   折叠与否都一样（折叠只是视觉上的裁切） */
		var codeBtn = t.closest ? t.closest('[data-copy-code]') : null;
		if (codeBtn) {
			e.preventDefault();
			var pre = codeBtn.closest('pre');
			var code = pre && pre.querySelector('code');
			if (code) copyText(code.textContent, function (ok) { flashLabel(codeBtn, ok); });
			return;
		}

		/* 代码层级折叠：点行号左边的 › */
		var gut = t.closest ? t.closest('[data-code-gutter]') : null;
		if (gut) {
			e.preventDefault();
			var box = gut.closest('pre');
			var rows = box ? box.querySelectorAll('code > .code-line') : null;
			if (rows) {
				var isOpen = gut.getAttribute('aria-expanded') === 'true';
				var from = +gut.getAttribute('data-from');
				var to = +gut.getAttribute('data-to');
				for (var n = from; n <= to && n < rows.length; n++) {
					rows[n].classList.toggle('fold-hidden', isOpen);
				}
				gut.setAttribute('aria-expanded', String(!isOpen));
				/* open 时箭头转向下（表示已展开） */
				gut.classList.toggle('open', !isOpen);
			}
			return;
		}

		/* 图片与流程图：点开进查看器。
		   包在 <a> 里的图片不接管 —— 那是「点图跳转」的写法。 */
		var target = t.closest ? t.closest('.post-content img, .mermaid-box') : null;
		if (!target) return;

		if (target.tagName === 'IMG') {
			if (target.closest('a')) return;
			e.preventDefault();
			openViewer(target, target.alt || '');
			return;
		}

		var svg = target.querySelector('svg');
		if (svg) openViewer(svg, '流程图');
	}

	if (!G.bound) {
		G.bound = true;
		document.addEventListener('click', onDocClick);
	}

	/* ---------- 图片注释 ----------
	   把 ![alt](src "说明") 变成 figure + figcaption。 */
	function initCaptions() {
		var imgs = root.querySelectorAll('.post-content img[title]');
		for (var i = 0; i < imgs.length; i++) {
			var img = imgs[i];
			var cap = img.getAttribute('title');
			if (!cap || !img.parentNode) continue;
			/* 去掉 title：留着它悬停时还会弹一次原生提示，和下方注释重复 */
			img.removeAttribute('title');

			var fig = document.createElement('figure');
			fig.className = 'fig-wrap';
			img.parentNode.insertBefore(fig, img);
			fig.appendChild(img);

			var fc = document.createElement('figcaption');
			fc.textContent = cap;
			fig.appendChild(fc);
		}
	}

	/* ---------- GitHub 仓库卡片 ----------
	   骨架由 {% ghcard %} 在构建期写好，这里只补描述与数字。
	   数据缓存在 localStorage：未认证的 GitHub 接口每 IP 每小时只有 60 次，
	   不缓存的话多刷几次页面就见底了。 */
	var GH_KEY = 'restart-ghcard:';
	var GH_TTL = 6 * 3600 * 1000;

	function ghPaint(box, d) {
		var desc = box.querySelector('.ghcard-desc');
		if (desc && d.description) desc.textContent = d.description;

		var meta = box.querySelector('.ghcard-meta');
		if (!meta) return;
		meta.textContent = '';

		function stat(icon, text) {
			if (text === undefined || text === null || text === '') return;
			var s = document.createElement('span');
			s.className = 'ghcard-stat';
			if (icon) {
				var i = document.createElement('i');
				i.className = 'fa ' + icon;
				i.setAttribute('aria-hidden', 'true');
				s.appendChild(i);
			}
			s.appendChild(document.createTextNode(String(text)));
			meta.appendChild(s);
		}

		stat('', d.language);
		stat('fa-star', d.stargazers_count);
		stat('fa-code-fork', d.forks_count);
	}

	function ghLoad(box) {
		var repo = box.getAttribute('data-repo');
		if (!repo || box.getAttribute('data-loaded')) return;
		box.setAttribute('data-loaded', '1');

		var key = GH_KEY + repo;
		try {
			var raw = localStorage.getItem(key);
			if (raw) {
				var o = JSON.parse(raw);
				if (o && o.t && Date.now() - o.t < GH_TTL && o.d) {
					ghPaint(box, o.d);
					return;
				}
			}
		} catch (e) { /* 隐私模式等，忽略即可，下面照常请求 */ }

		if (!window.fetch) return;

		fetch('https://api.github.com/repos/' + repo)
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (d) {
				if (!d || !d.full_name) return;
				/* 只留用得上的字段，整个响应塞进 localStorage 太占地方 */
				var slim = {
					description: d.description,
					language: d.language,
					stargazers_count: d.stargazers_count,
					forks_count: d.forks_count
				};
				ghPaint(box, slim);
				try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: slim })); } catch (e) {}
			})
			.catch(function () { /* 拿不到就保持骨架：仓库名和链接本来就在 */ });
	}

	function initGhCards() {
		var boxes = root.querySelectorAll('.ghcard[data-repo]');
		for (var i = 0; i < boxes.length; i++) ghLoad(boxes[i]);
	}

	/* ---------- 流程图 ---------- */

	var MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';

	/* 取当前的令牌实际值：mermaid 不认 CSS 变量，只能把算好的色值喂给它 */
	function mermaidVars() {
		var cs = getComputedStyle(document.documentElement);
		function v(name, dflt) {
			var x = cs.getPropertyValue(name).trim();
			return x || dflt;
		}
		return {
			background: v('--c-code-bg', '#fbfbfb'),
			primaryColor: v('--c-surface', '#fafafa'),
			primaryTextColor: v('--c-text', '#3d3d3d'),
			primaryBorderColor: v('--c-border-strong', '#d2d2d2'),
			lineColor: v('--c-muted', '#999999'),
			textColor: v('--c-text', '#3d3d3d'),
			fontFamily: v('--font-sans', 'sans-serif')
		};
	}

	function renderMermaid() {
		if (!window.mermaid || !G.mermaidJobs.length) return;
		window.mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'loose',
			theme: 'base',
			themeVariables: mermaidVars()
		});
		G.mermaidJobs.forEach(function (box) {
			if (!box.parentNode) return;
			box.removeAttribute('data-processed');
			box.removeAttribute('data-failed');
			box.textContent = box.getAttribute('data-src') || '';
			try {
				window.mermaid.run({ nodes: [box] });
			} catch (e) {
				box.setAttribute('data-failed', '1');
			}
		});
	}

	function initMermaid() {
		var codes = root.querySelectorAll('.post-content pre > code.language-mermaid');
		if (!codes.length) return;

		var jobs = [];
		for (var i = 0; i < codes.length; i++) {
			var code = codes[i];
			var pre = code.parentNode;
			var box = document.createElement('div');
			box.className = 'mermaid-box';
			/* 原文留着：切主题要重渲染，而且渲染失败时还能看出画的是什么 */
			box.setAttribute('data-src', code.textContent);
			pre.parentNode.replaceChild(box, pre);
			jobs.push(box);
		}

		G.mermaidJobs = jobs;

		if (window.mermaid) {
			renderMermaid();
		} else {
			var s = document.createElement('script');
			s.src = MERMAID_SRC;
			s.async = true;
			s.onload = renderMermaid;
			document.head.appendChild(s);
		}

		/* mermaid 的颜色是渲染时写死进 SVG 的，主题一变就得重画。
		   监听只挂一次，重画用的节点集合每次换页刷新（G.mermaidJobs）。 */
		if (!G.themeWatched) {
			G.themeWatched = true;
			var rerender = function () { setTimeout(renderMermaid, 60); };
			if (window.MutationObserver) {
				new MutationObserver(rerender).observe(document.documentElement, {
					attributes: true,
					attributeFilter: ['data-theme']
				});
			}
			if (window.matchMedia) {
				var mq = window.matchMedia('(prefers-color-scheme: dark)');
				if (mq.addEventListener) mq.addEventListener('change', rerender);
				else if (mq.addListener) mq.addListener(rerender);
			}
		}
	}

	/* ---------- 数学公式 ----------
	   KaTeX 的三个文件是 defer 加载的（见 post.ejs），换页后动态插入时
	   又不保证已经就绪，所以这里等一等再渲染。 */
	function initKatex(tries) {
		if (!window.renderMathInElement) {
			if ((tries || 0) < 20) setTimeout(function () { initKatex((tries || 0) + 1); }, 100);
			return;
		}
		try {
			window.renderMathInElement(root, {
				delimiters: [
					{ left: '$$', right: '$$', display: true },
					{ left: '$', right: '$', display: false },
					{ left: '\\[', right: '\\]', display: true },
					{ left: '\\(', right: '\\)', display: false }
				],
				/* 代码块里的 $ 不是公式 */
				ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
				throwOnError: false
			});
		} catch (e) { /* 公式写错不该把整页脚本带崩 */ }
	}

	/* ---------- 媒体查看器 ----------
	   图片和流程图共用一个：点开铺满全屏，可缩放、旋转、拖动。
	   桌面用滚轮与按钮，移动端用单指拖动 + 双指捏合。
	   统一用 Pointer Events，不为鼠标和触摸各写一套。 */
	var V = null;

	function viewerApply() {
		if (!V) return;
		V.media.style.transform = 'translate(' + V.x + 'px,' + V.y + 'px) rotate(' +
			V.rotation + 'deg) scale(' + V.scale + ')';
		V.label.textContent = Math.round(V.scale * 100) + '%';
	}

	function viewerKey(e) {
		if (!V) return;
		if (e.key === 'Escape') viewerClose();
		else if (e.key === '+' || e.key === '=') viewerZoom(1.25);
		else if (e.key === '-') viewerZoom(0.8);
		else if (e.key === '0') viewerReset();
	}

	function viewerClose() {
		if (!V) return;
		var el = V.el;
		V = null;
		document.removeEventListener('keydown', viewerKey);
		document.body.classList.remove('viewer-open');
		el.classList.remove('on');
		/* 等淡出走完再摘，否则图先消失、遮罩后消失 */
		setTimeout(function () {
			if (el.parentNode) el.parentNode.removeChild(el);
		}, 180);
	}

	function viewerZoom(factor) {
		if (!V) return;
		V.scale = Math.min(8, Math.max(.3, V.scale * factor));
		viewerApply();
	}

	function viewerReset() {
		if (!V) return;
		V.scale = 1;
		V.rotation = 0;
		V.x = 0;
		V.y = 0;
		viewerApply();
	}

	function bindViewerStage(stage) {
		/* 滚轮缩放 */
		stage.addEventListener('wheel', function (e) {
			if (!V) return;
			e.preventDefault();
			viewerZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
		}, { passive: false });

		/* 工具栏、关闭、点空白关闭——一个委托搞定 */
		V.el.addEventListener('click', function (e) {
			var t = e.target;
			if (!t || !t.closest || !V) return;

			if (t.closest('.viewer-close')) { viewerClose(); return; }

			var btn = t.closest('[data-viewer]');
			if (btn) {
				var act = btn.getAttribute('data-viewer');
				if (act === 'in') viewerZoom(1.25);
				else if (act === 'out') viewerZoom(.8);
				else if (act === 'rotate') { V.rotation = (V.rotation + 90) % 360; viewerApply(); }
				else if (act === 'reset') viewerReset();
				return;
			}

			if (!t.closest('.viewer-media') && !t.closest('.viewer-toolbar') && !t.closest('.viewer-cap')) {
				viewerClose();
			}
		});

		/* 单指拖动、双指捏合 */
		stage.addEventListener('pointerdown', function (e) {
			if (!V) return;
			V.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
			V.moved = 0;
			/* 指针捕获：手指滑出舞台也不丢事件 */
			try { stage.setPointerCapture(e.pointerId); } catch (err) {}
			stage.classList.add('dragging');
		});

		stage.addEventListener('pointermove', function (e) {
			if (!V) return;
			var prev = V.pointers[e.pointerId];
			if (!prev) return;

			var ids = Object.keys(V.pointers);

			if (ids.length === 1) {
				V.x += e.clientX - prev.x;
				V.y += e.clientY - prev.y;
				V.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
				viewerApply();
			} else if (ids.length >= 2) {
				prev.x = e.clientX;
				prev.y = e.clientY;

				var a = V.pointers[ids[0]];
				var b = V.pointers[ids[1]];
				var dist = Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
				var midX = (a.x + b.x) / 2;
				var midY = (a.y + b.y) / 2;

				if (V.pinch) {
					/* 缩放比取两指距离的变化，同时跟着中点平移，捏起来才跟手 */
					V.scale = Math.min(8, Math.max(.3, V.scale * (dist / V.pinch)));
					V.x += midX - V.midX;
					V.y += midY - V.midY;
					V.moved = 99; /* 捏合过就不算「点空白关闭」 */
					viewerApply();
				}
				V.pinch = dist;
				V.midX = midX;
				V.midY = midY;
				return;
			}

			prev.x = e.clientX;
			prev.y = e.clientY;
		});

		function release(e) {
			if (!V || !V.pointers[e.pointerId]) return;
			delete V.pointers[e.pointerId];
			if (Object.keys(V.pointers).length < 2) V.pinch = 0;
			if (!Object.keys(V.pointers).length) stage.classList.remove('dragging');
		}

		stage.addEventListener('pointerup', release);
		stage.addEventListener('pointercancel', release);

		/* 双击：适应窗口 ⇄ 放大 2× */
		stage.addEventListener('dblclick', function (e) {
			if (!V) return;
			if (e.target.closest && e.target.closest('.viewer-media') && V.scale > 1.05) {
				viewerReset();
			} else if (V.scale <= 1.05) {
				viewerReset();
				viewerZoom(2);
			}
		});
	}

	function openViewer(source, caption) {
		viewerClose();

		var el = document.createElement('div');
		el.className = 'viewer';

		var stage = document.createElement('div');
		stage.className = 'viewer-stage';

		/* 图片取浏览器实际选中的那张；
		   流程图整棵克隆并去掉写死的宽高，交给 CSS 自适应 */
		var media;
		if (source.tagName === 'IMG') {
			media = document.createElement('img');
			media.src = source.currentSrc || source.src;
			media.alt = source.alt || '';
		} else {
			media = source.cloneNode(true);
			media.removeAttribute('width');
			media.removeAttribute('height');
		}
		media.classList.add('viewer-media');
		stage.appendChild(media);

		var cap = document.createElement('p');
		cap.className = 'viewer-cap';
		if (caption) cap.textContent = caption;
		else cap.hidden = true;

		var bar = document.createElement('div');
		bar.className = 'viewer-toolbar';

		var label = document.createElement('span');
		label.className = 'viewer-scale';

		[['out', '−', '缩小'], ['in', '＋', '放大'], ['rotate', '↻', '旋转'], ['reset', '↺', '重置']]
			.forEach(function (b) {
				var btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'viewer-btn';
				btn.setAttribute('data-viewer', b[0]);
				btn.setAttribute('aria-label', b[2]);
				btn.textContent = b[1];
				bar.appendChild(btn);
				if (b[0] === 'in') bar.appendChild(label); /* 百分比跟在放大键后面 */
			});

		var close = document.createElement('button');
		close.type = 'button';
		close.className = 'viewer-close';
		close.setAttribute('aria-label', '关闭');
		close.textContent = '×';

		el.appendChild(stage);
		el.appendChild(cap);
		el.appendChild(bar);
		el.appendChild(close);
		document.body.appendChild(el);

		V = {
			el: el, stage: stage, media: media, label: label,
			scale: 1, rotation: 0, x: 0, y: 0,
			pointers: {}, pinch: 0, midX: 0, midY: 0, moved: 0
		};

		void el.offsetWidth; /* 强制重排，让淡入跑起来 */
		el.classList.add('on');
		/* 锁住页面滚动，免得拖图时背景跟着动 */
		document.body.classList.add('viewer-open');
		document.addEventListener('keydown', viewerKey);

		bindViewerStage(stage);
	}

	/* ---------- 代码块：复制与折叠 ----------
	   prism 是服务端预处理（没有客户端 prism.js），所以工具栏得自己建。
	   语言角标是 post.js 挂上去的，这里把它挪进同一条工具条里排，
	   省得两个绝对定位的元素在右上角打架。 */
	var FOLD_LINES = 16;

	function initCodeBlocks() {
		var pres = root.querySelectorAll('.post-content pre, .rich pre');

		for (var i = 0; i < pres.length; i++) {
			var pre = pres[i];
			var code = pre.querySelector('code');
			if (!code) continue;

			/* 行数：优先数 post.js 拆好的块级行，没有就按换行数 */
			var lines = code.querySelectorAll('.code-line').length;
			if (!lines) lines = code.textContent.replace(/\n+$/, '').split('\n').length;

			/* ---- 工具条：语言角标 + 复制 ---- */
			if (!pre.querySelector('.code-actions')) {
				var bar = document.createElement('div');
				bar.className = 'code-actions';

				var lang = pre.querySelector('.code-lang');
				if (lang) bar.appendChild(lang);

				var copy = document.createElement('button');
				copy.type = 'button';
				copy.className = 'code-copy';
				copy.setAttribute('data-copy-code', '1');
				copy.setAttribute('aria-label', '复制代码');
				copy.textContent = '复制';
				bar.appendChild(copy);

				pre.appendChild(bar);
				pre.classList.add('has-actions');
			}

			/* ---- 折叠：只对长代码块生效 ---- */
			if (lines > FOLD_LINES && !pre.querySelector('.code-fold')) {
				var btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'code-fold';
				btn.textContent = '展开全部（共 ' + lines + ' 行）';
				btn.setAttribute('aria-expanded', 'false');

				btn.addEventListener('click', function () {
					var folded = !this.parentNode.classList.contains('is-folded');
					this.parentNode.classList.toggle('is-folded', folded);
					this.textContent = folded ? '展开全部（共 ' + this.getAttribute('data-lines') + ' 行）' : '收起';
					this.setAttribute('aria-expanded', String(!folded));
				});
				btn.setAttribute('data-lines', lines);

				pre.appendChild(btn);
				pre.classList.add('is-folded');
			}
		}
	}

	/* ---------- 代码层级折叠（fold gutter） ----------
	   按缩进判断块：某一行之后如果出现更深的缩进，它就是一个块的开始，
	   行号左边给一个 ›，点它把这段子行收起来 —— 和编辑器里的折叠一样。
	   行号本身是 CSS 计数器（.code-line::before），隐藏的行不参与渲染、
	   计数器也不递增，所以收起来之后行号依然是连续的。 */
	function addGutter(lines, indent, start, next) {
		var base = indent[start];

		/* 折叠范围：从起点的下一行，到第一个「缩进回到同级或更浅」的行为止 */
		var end = lines.length - 1;
		for (var k = next; k < lines.length; k++) {
			if (!lines[k].textContent.trim()) continue;
			if (indent[k] <= base) { end = k - 1; break; }
		}

		var btn = document.createElement('button');
		btn.type = 'button';
		/* 加载时这一段本来就是展开的，箭头要朝下；
		   收起后才去掉 .open，转回朝右 */
		btn.className = 'code-folder open';
		btn.setAttribute('data-code-gutter', '1');
		btn.setAttribute('data-from', start + 1);
		btn.setAttribute('data-to', end);
		btn.setAttribute('aria-expanded', 'true');
		btn.setAttribute('aria-label', '收起这一段');
		btn.textContent = '›';
		lines[start].appendChild(btn);
	}

	function initCodeGutters() {
		var pres = root.querySelectorAll('.post-content pre.code-wrap, .rich pre.code-wrap');

		for (var p = 0; p < pres.length; p++) {
			var lines = pres[p].querySelectorAll('code > .code-line');
			if (lines.length < 3) continue;

			var indent = [];
			for (var i = 0; i < lines.length; i++) {
				var m = /^[ \t]*/.exec(lines[i].textContent);
				/* 制表符按 4 个空格折算，混用也能比出层级 */
				indent.push(m ? m[0].replace(/\t/g, '    ').length : 0);
			}

			/* 空行不参与层级判断，但会被一起收进去 */
			function nextCode(k) {
				while (k < lines.length && !lines[k].textContent.trim()) k++;
				return k;
			}

			for (var q = 0; q < lines.length - 1; q++) {
				var j = nextCode(q + 1);
				if (j >= lines.length || indent[j] <= indent[q]) continue;
				addGutter(lines, indent, q, j);
			}
		}
	}

	/* ---------- 分享二维码 ---------- */
	var QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';

	function initShareQr() {
		var box = document.getElementById('share-qr');
		if (!box || box.getAttribute('data-ready')) return;

		function draw() {
			if (!window.QRCode || !box.parentNode) return;
			box.setAttribute('data-ready', '1');
			box.textContent = '';
			new window.QRCode(box, {
				text: location.href,
				width: 96,
				height: 96,
				/* 深码浅底写死：二维码得有浅底才扫得动，
				   不能跟着暗色主题一起变深 */
				colorDark: '#111111',
				colorLight: '#ffffff',
				correctLevel: window.QRCode.CorrectLevel.M
			});
		}

		function load() {
			if (window.QRCode) { draw(); return; }
			var s = document.createElement('script');
			s.src = QR_SRC;
			s.async = true;
			s.onload = draw;
			document.head.appendChild(s);
		}

		/* 二维码在文章最底部，滚到附近再画 */
		if ('IntersectionObserver' in window) {
			var io = new IntersectionObserver(function (entries) {
				for (var i = 0; i < entries.length; i++) {
					if (!entries[i].isIntersecting) continue;
					io.disconnect();
					load();
					return;
				}
			}, { rootMargin: '150px 0px' });
			io.observe(box);
		} else {
			load();
		}
	}

	/* ---------- 每次都跑 ---------- */
	initCaptions();
	initCodeBlocks();
	initCodeGutters();
	initGhCards();
	initMermaid();
	initKatex(0);
	initShareQr();
})();
