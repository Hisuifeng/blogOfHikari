/* ==========================================================
   main.js — 全站通用交互
   导航高亮 / 汉堡菜单 / 滚动隐藏导航 / 回到顶部 / 主题切换 / 进场动画

   分成两段，是因为站内换页走的是 pjax（js/pjax.js）：导航、页脚、播放器
   都在 #content 之外，不会随换页重建，所以
     · 「只绑一次」的部分：导航、汉堡、回到顶部、主题切换、滚动监听；
     · 「每次换页都要重跑」的部分：进场动画。
   后者挂到 window.__restartInitPage 上，pjax 换完内容直接调用。
   ========================================================== */
(function () {
	'use strict';

	var nav = document.querySelector('.topnav');
	var menu = document.getElementById('nav-menu');
	var burger = document.getElementById('hamburger');
	var toTop = document.getElementById('back-to-top');

	/* ---------- 当前项高亮 ----------
	   换页后导航是旧的，必须能重新点亮，所以单独抽成函数并挂到 window 上。
	   用 toggle 而不是 add：换页时上一页的 active 还挂在同一个 <a> 上。 */
	function normalize(p) {
		return p.replace(/\/+$/, '') || '/';
	}

	function markNav(pathname) {
		if (!menu) return;
		var here = normalize(pathname || location.pathname);

		menu.querySelectorAll('a[data-nav]').forEach(function (a) {
			var target = normalize(a.getAttribute('data-nav') || '/');
			var isRoot = target === '/';
			var hit = target === here ||
				(!isRoot && here.indexOf(target + '/') === 0);
			a.classList.toggle('active', hit);
		});
	}

	markNav();
	window.__restartMarkNav = markNav;

	/* ---------- 汉堡菜单（≤768px） ---------- */
	function setMenu(open) {
		if (!menu || !burger) return;
		menu.classList.toggle('show', open);
		burger.setAttribute('aria-expanded', String(open));
		burger.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
	}

	if (burger && menu) {
		burger.addEventListener('click', function (e) {
			e.stopPropagation();
			setMenu(!menu.classList.contains('show'));
		});

		menu.addEventListener('click', function (e) {
			if (e.target.closest('a')) setMenu(false);
		});

		document.addEventListener('click', function (e) {
			if (menu.classList.contains('show') &&
				!menu.contains(e.target) && !burger.contains(e.target)) {
				setMenu(false);
			}
		});

		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && menu.classList.contains('show')) {
				setMenu(false);
				burger.focus();
			}
		});

		var timer;
		window.addEventListener('resize', function () {
			clearTimeout(timer);
			timer = setTimeout(function () {
				if (window.innerWidth > 768) setMenu(false);
			}, 100);
		});
	}

	/* ---------- 滚动：隐藏导航 / 毛玻璃 / 显示回到顶部 ---------- */
	if (nav || toTop) {
		var lastY = window.scrollY;
		var ticking = false;

		/* 距顶部多少像素内算「在顶部」。留一点余量，避免刚滚动时在 0 附近来回抖动。 */
		var GLASS_AT = 8;

		function onScroll() {
			var y = window.scrollY;
			var down = y > lastY;

			if (toTop) toTop.classList.toggle('show', y > 320);

			if (nav) {
				/* 在顶部时导航盖在首页 hero 上，加毛玻璃让 wallpaper 透出来；
				   一旦向下滚过 GLASS_AT 就撤掉，回到纯白底，保证正文可读。
				   复用同一段 rAF 节流回调，不额外注册 scroll 监听。 */
				nav.classList.toggle('glass', y <= GLASS_AT);

				if (y < 120) {
					nav.classList.remove('hidden');
				} else if (down && y - lastY > 6) {
					nav.classList.add('hidden');
				} else if (!down) {
					nav.classList.remove('hidden');
				}
			}

			lastY = y;
			ticking = false;
		}

		window.addEventListener('scroll', function () {
			if (!ticking) {
				window.requestAnimationFrame(onScroll);
				ticking = true;
			}
		}, { passive: true });

		/* 换页后滚动位置归零，导航的显隐/毛玻璃要跟着回到初始状态 */
		window.__restartResetScroll = function () {
			lastY = window.scrollY;
			onScroll();
		};

		onScroll();
	}

	/* ---------- 回到顶部 ---------- */
	if (toTop) {
		toTop.addEventListener('click', function (e) {
			e.preventDefault();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});
	}

	/* ---------- 主题切换（跟随系统 / 浅色 / 暗色） ----------
	   初始 data-theme 由 layout.ejs 里的内联脚本写好（防止白闪），
	   这里只处理点击循环、系统变化和按钮提示文案。
	   档位不写进 DOM 之外的地方：data-theme 有值 = 手动档，没有 = 跟随系统，
	   这样 CSS 那份 prefers-color-scheme 兜底才能继续生效。 */
	(function () {
		var root = document.documentElement;
		var btn = document.getElementById('theme-toggle');
		if (!btn) return;

		var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

		function currentMode() {
			var t = root.getAttribute('data-theme');
			return (t === 'light' || t === 'dark') ? t : 'auto';
		}

		/* 实际生效的明暗：auto 时看系统。只用于主题色 meta 和提示文案。 */
		function effective() {
			var m = currentMode();
			if (m !== 'auto') return m;
			return systemDark() ? 'dark' : 'light';
		}

		/* 系统的明暗，和用户当前档位无关。 */
		function systemDark() {
			return !!(mq && mq.matches);
		}

		var LABEL = { auto: '跟随系统', light: '浅色', dark: '暗色' };
		var meta = document.querySelector('meta[name="theme-color"]');

		function syncChrome() {
			btn.setAttribute('aria-label', '切换主题（当前：' + LABEL[currentMode()] + '）');
			btn.setAttribute('title', '当前：' + LABEL[currentMode()] + '，点击切换');
			/* 地址栏/状态栏颜色跟着走，不然暗色页面顶着一条白边。 */
			if (meta) meta.setAttribute('content', effective() === 'dark' ? '#16181d' : '#ffffff');
		}

		/* 三档循环：auto → 系统反面 → 另一档 → auto。
		   先跳「系统的反面」，保证从 auto 出发第一下就有肉眼可见的变化；
		   第二档再走到另一个显式档，浅色/暗色两个图标都点得到 ——
		   如果这里用 effective() 取「反面」，那切到暗色后 effective() 就变成
		   暗色本身，再也算不出系统的反面，循环会塌成 auto ↔ 暗色，
		   太阳图标永远点不出来。所以必须用 systemDark() 而不是 effective()。
		   例：系统浅色时顺序是 auto → 暗 → 浅 → auto。 */
		function nextMode() {
			var m = currentMode();
			var mid = systemDark() ? 'light' : 'dark';
			var other = mid === 'light' ? 'dark' : 'light';
			if (m === 'auto') return mid;
			if (m === mid) return other;
			return 'auto';
		}

		btn.addEventListener('click', function () {
			var next = nextMode();
			if (next === 'auto') root.removeAttribute('data-theme');
			else root.setAttribute('data-theme', next);
			try { localStorage.setItem('theme', next); } catch (e) {}
			syncChrome();
		});

		/* 跟随系统那一档下系统切换时，要更新主题色和提示
		   （颜色本身由 CSS 媒体查询自动跟，不需要这里动手）。 */
		if (mq) {
			var onChange = function () { if (currentMode() === 'auto') syncChrome(); };
			if (mq.addEventListener) mq.addEventListener('change', onChange);
			else if (mq.addListener) mq.addListener(onChange);
		}

		syncChrome();
	})();

	/* ---------- 进场动画（每次换页都要重跑） ----------
	   下面这些块分两种处理，原因是实测出来的，不是设计偏好：

	   1) 加载时已在视口内 -> 直接用纯 CSS 动画（data-reveal-now）。
	      补间（transition）要求元素先被真正绘制成 opacity:0，
	      浏览器才有插值起点。但首屏元素从解析完成到首次绘制只隔一两帧，
	      中间态来不及渲染，于是 opacity 从 1 跳到 1，动画根本不播 ——
	      表现就是「类名和状态都对，但看不到任何淡入」。
	      CSS 动画自带起始帧，不依赖是否存在那一帧，所以一定播得出来。

	   2) 加载时在视口外 -> 用 IO 补间（data-reveal + .is-in）。
	      它们在滚入视口前有充足帧数被绘制成 opacity:0，补间能正常播放，
      同时保留了「滚到才动」的效果。

	   has-reveal 必须在确认支持 IntersectionObserver 之后才加。不支持就直接
	   return，元素上没有任何标记，CSS 的隐藏规则不生效，内容照常显示。 */
	var REVEAL_SEL = [
		'.post-item', '.archive-year', '.archive-item', '.cat-item', '.cloud-item',
		'.friend-item', '.qr-item', '.side-card', '.toc-box',
		'.home-archive-year'
	].join(', ');

	function initPage() {
		if (!('IntersectionObserver' in window)) return;

		var revealTargets = document.querySelectorAll(REVEAL_SEL);

		if (!revealTargets.length) return;

		document.documentElement.classList.add('has-reveal');

		var revealIO = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (!entry.isIntersecting) return;
				entry.target.classList.add('is-in');
				/* 只播一次，播完就取消观察，减少回调开销 */
				revealIO.unobserve(entry.target);
			});
		}, {
			/* 底部收一点，让元素真正进入视口再播，而不是刚露头就动 */
			rootMargin: '0px 0px -6% 0px',
			threshold: 0.04
		});

		/* 放宽到 1.2 屏：略微在折叠线下方的元素，滚一点点就能看到，
		   提前按首屏处理观感更连贯。 */
		var fold = window.innerHeight * 1.2;

		Array.prototype.forEach.call(revealTargets, function (el) {
			if (el.getBoundingClientRect().top < fold) {
				el.setAttribute('data-reveal-now', '');
				return;
			}
			el.setAttribute('data-reveal', '');
			revealIO.observe(el);
		});
	}

	window.__restartInitPage = initPage;
	initPage();
})();
