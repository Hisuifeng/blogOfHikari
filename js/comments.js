/* ==========================================================================
   comments.js — Twikoo 评论区的加载

   容器与配置见 layout/_partial/comments.ejs，样式见 css/comments.css。

   三件事：
     · 滚到评论区附近才注入 twikoo.min.js，文章首屏不为它让路；
     · 脚本是全局的，pjax 换页后复用已经加载好的那份，不重复拉取 ——
       重复加载会往 head 里再塞一份 Twikoo 样式，也会白跑一次网络请求；
     · 挂载前先确认 Twikoo 真的可用，没挂上就给一句提示而不是抛错。

   Twikoo 的明暗是「跟随文字色」的（样式里大量用 currentColor 和半透明色），
   所以不需要像 iframe 类评论系统那样用 postMessage 通知它换主题，
   只要容器继承了主题的 --c-text 就行。
   ========================================================================== */
(function () {
	'use strict';

	var box = document.getElementById('tcomment');
	/* 取不到容器说明这页没开评论；data-ready 挡住同一容器的重复初始化 */
	if (!box || box.getAttribute('data-ready')) return;
	box.setAttribute('data-ready', '1');

	var started = false;

	/* Twikoo 是否真的可用。
	   这里不能只写 `if (window.twikoo)`：浏览器会给每个带 id 的元素建一个同名全局，
	   容器 id 一旦叫 twikoo，拿到的就是那个 DOM 元素 —— truthy，但没有 init，
	   于是 init() 里报 "window.twikoo.init is not a function"。
	   所以容器 id 用的是 tcomment（与 Twikoo 官方示例一致），这里再判一次类型兜底。 */
	function ready() {
		return !!(window.twikoo && typeof window.twikoo.init === 'function');
	}

	function fallback() {
		if (box.querySelector('.tk-comments') || box.querySelector('.comments-fallback')) return;
		var p = document.createElement('p');
		p.className = 'comments-fallback';
		p.textContent = '评论加载失败，请检查网络后刷新重试。';
		box.appendChild(p);
	}

	function init() {
		if (started) return;
		if (!ready()) {
			/* 脚本请求回来了，却没挂上 twikoo：多半是被拦了或返回了别的页面 */
			fallback();
			return;
		}
		started = true;

		var opt = {
			envId: box.getAttribute('data-env-id'),
			el: '#tcomment',
			lang: box.getAttribute('data-lang') || 'zh-CN'
		};

		/* path 留空就用 Twikoo 默认的 location.pathname，不要传空串，
		   否则所有文章的评论会挤在同一条路径下 */
		var path = box.getAttribute('data-path');
		if (path) opt.path = path;

		var p = window.twikoo.init(opt);
		/* init 在某些失败场景下返回 rejected promise，接住它，
		   免得控制台里冒一个没人处理的 unhandledrejection */
		if (p && p.catch) p.catch(function () {});
	}

	function load() {
		if (ready()) {
			init();
			return;
		}

		var s = document.createElement('script');
		s.src = box.getAttribute('data-src');
		s.async = true;
		s.onload = init;
		s.onerror = fallback;
		document.head.appendChild(s);
	}

	/* 滚到评论区附近才开始加载 */
	if ('IntersectionObserver' in window) {
		var io = new IntersectionObserver(function (entries) {
			for (var i = 0; i < entries.length; i++) {
				if (!entries[i].isIntersecting) continue;
				io.disconnect();
				load();
				return;
			}
		}, { rootMargin: '200px 0px' });
		io.observe(box);
	} else {
		load();
	}
})();
