/* ==========================================================
   main.js — 全站通用交互
   导航高亮 / 汉堡菜单 / 滚动隐藏导航 / 回到顶部
   无依赖，原生实现
   ========================================================== */
(function () {
	'use strict';

	var nav = document.querySelector('.topnav');
	var menu = document.getElementById('nav-menu');
	var burger = document.getElementById('hamburger');
	var toTop = document.getElementById('back-to-top');

	/* ---------- 当前项高亮 ---------- */
	function normalize(p) {
		return p.replace(/\/+$/, '') || '/';
	}

	var here = normalize(location.pathname);

	if (menu) {
		menu.querySelectorAll('a[data-nav]').forEach(function (a) {
			var target = normalize(a.getAttribute('data-nav') || '/');
			var isRoot = target === '/';
			var hit = target === here ||
				(!isRoot && here.indexOf(target + '/') === 0);
			if (hit) a.classList.add('active');
		});
	}

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

		onScroll();
	}

	/* ---------- 回到顶部 ---------- */
	if (toTop) {
		toTop.addEventListener('click', function (e) {
			e.preventDefault();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});
	}

	/* ---------- 进场动画 ----------
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
})();
