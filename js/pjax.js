/* ==========================================================
   pjax.js — 站内无刷新换页
   只替换 #content，导航/页脚/播放器留在原地。

   为什么需要它：整页跳转会把 <audio> 一起销毁，音乐必然断一下；
   播放器节点在 #content 之外，只换内容就等于换页时音乐不停。
   仅在主题配置 music.enable 且 music.keep_playing 未关时由 layout.ejs 引入。

   保守原则：任何一步失败（网络错、不是 HTML、结构对不上）立刻退回
   location.href 让浏览器自己跳，绝不把用户卡在原地。
   ========================================================== */
(function () {
	'use strict';

	if (!window.fetch || !window.history || !history.pushState || !window.DOMParser) return;
	if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

	var CONTENT = '#content';

	/* 指向文件而不是页面的链接不接管 */
	var SKIP_EXT = /\.(xml|json|txt|pdf|zip|rar|7z|png|jpe?g|gif|webp|svg|ico|bmp|mp3|m4a|wav|ogg|flac|mp4|webm|css|js|map)$/i;

	function eligible(a, e) {
		if (!a || !a.getAttribute) return false;
		if (a.target && a.target !== '_self') return false;
		if (a.hasAttribute('download')) return false;
		if (a.hasAttribute('data-no-pjax')) return false;
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return false;

		var href = a.getAttribute('href');
		if (!href || href.charAt(0) === '#') return false;
		if (/^(mailto:|tel:|javascript:)/i.test(href)) return false;

		var url;
		try {
			url = new URL(a.href, location.href);
		} catch (err) {
			return false;
		}
		if (url.origin !== location.origin) return false;
		if (SKIP_EXT.test(url.pathname)) return false;
		/* 同页锚点交给浏览器原生处理 */
		if (url.pathname === location.pathname && url.search === location.search) return false;

		return true;
	}

	/* innerHTML 插入的 <script> 不会执行，必须逐个换成新节点重放。
	   换页时这里通常只有 post.js / search.js 两个，代价可以忽略。 */
	function activate(root) {
		Array.prototype.slice.call(root.querySelectorAll('script')).forEach(function (old) {
			var s = document.createElement('script');
			for (var k = 0; k < old.attributes.length; k++) {
				s.setAttribute(old.attributes[k].name, old.attributes[k].value);
			}
			if (!old.src) s.textContent = old.textContent;
			old.parentNode.replaceChild(s, old);
		});
	}

	function swap(html, url) {
		var doc = new DOMParser().parseFromString(html, 'text/html');
		var next = doc.querySelector(CONTENT);
		var cur = document.querySelector(CONTENT);
		if (!next || !cur) throw new Error('no #content');

		document.title = doc.title || document.title;

		var nd = doc.querySelector('meta[name="description"]');
		var cd = document.querySelector('meta[name="description"]');
		if (nd && cd) cd.setAttribute('content', nd.getAttribute('content') || '');

		/* className 也要跟着换：首页的 #content 带 has-hero，别的页面没有 */
		cur.className = next.className;
		cur.innerHTML = next.innerHTML;

		activate(cur);

		if (window.__restartMarkNav) {
			window.__restartMarkNav(new URL(url, location.href).pathname);
		}
		if (window.__restartInitPage) window.__restartInitPage();
		if (window.__restartResetScroll) window.__restartResetScroll();

		/* 让 main.css 里 #content 的淡入重播一次，换页不至于「硬切」 */
		var anim = cur.style.animation;
		cur.style.animation = 'none';
		void cur.offsetHeight;
		cur.style.animation = anim || '';

		document.dispatchEvent(new CustomEvent('restart:page', { detail: { url: url } }));
	}

	function go(url, push, restoreY) {
		var cur = document.querySelector(CONTENT);
		if (!cur) {
			location.href = url;
			return;
		}

		fetch(url, { credentials: 'same-origin' })
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				var type = res.headers.get('content-type') || '';
				if (type && type.indexOf('text/html') === -1) throw new Error('not html');
				return res.text();
			})
			.then(function (html) {
				swap(html, url);
				if (push) {
					history.pushState({ pjax: true, scroll: 0 }, '', url);
				}
				window.scrollTo(0, restoreY || 0);
			})
			.catch(function () {
				location.href = url;
			});
	}

	document.addEventListener('click', function (e) {
		if (e.defaultPrevented) return;

		var a = e.target && e.target.closest ? e.target.closest('a') : null;
		if (!eligible(a, e)) return;

		/* 记下当前条目的滚动位置，后退时按它恢复 */
		try {
			history.replaceState({ pjax: true, scroll: window.scrollY }, '', location.href);
		} catch (err) {}

		e.preventDefault();
		go(a.href, true, 0);
	});

	window.addEventListener('popstate', function (e) {
		var y = (e.state && typeof e.state.scroll === 'number') ? e.state.scroll : 0;
		go(location.href, false, y);
	});
})();
