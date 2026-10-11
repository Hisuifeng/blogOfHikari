/* ==========================================================================
   side.js — 侧栏要不要吸顶

   .home-side 是 sticky + max-height + overflow-y:auto（见 index.css）：
   内容一旦比视口高，它就自带一条内部滚动条。那条滚动条很难用 ——
   从外观上看不出下面还有内容，滚轮还得先落在侧栏上才滚得动。

   所以这里量一次高度：
     · 装得下 → 保持吸顶，滚页面时侧栏停在那里，名片/日历一直看得见；
     · 装不下 → 加 .side-tall 摘掉吸顶，整块跟着页面滚，没有内部滚动条。

   侧栏里的「最近说说」是异步拉来的（js/memos.js），拉完高度会变，
   所以额外挂一个 ResizeObserver 盯着侧栏自己的尺寸变化；
   换页（pjax）后是新的节点，由 restart:page 重跑。
   只在首页引入（侧栏只有首页有）。
   ========================================================================== */
(function () {
	'use strict';

	/* 可用高度 = 视口高度 − 吸顶偏移 − 底部余量。
	   偏移从计算样式里读，免得把 calc(var(--nav-h) + 20px) 抄一遍。 */
	function limitOf(side) {
		var top = parseFloat(window.getComputedStyle(side).top);
		if (isNaN(top)) top = 0;
		return window.innerHeight - top - 20;
	}

	function fit(side) {
		/* scrollHeight 是内容高度，不受 max-height 影响，可以直接拿来比 */
		side.classList.toggle('side-tall', side.scrollHeight > limitOf(side));
	}

	function watch(side) {
		if (side.getAttribute('data-side-fit')) return;
		side.setAttribute('data-side-fit', '1');

		fit(side);

		/* 防抖：改窗口大小时 resize 会连着来，量一次就够 */
		var timer = 0;
		function again() {
			clearTimeout(timer);
			timer = setTimeout(function () { fit(side); }, 80);
		}

		window.addEventListener('resize', again);

		/* 说说、日历都是渲染完才撑开高度的 */
		if (window.ResizeObserver) new ResizeObserver(again).observe(side);
	}

	function boot() {
		Array.prototype.forEach.call(document.querySelectorAll('.home-side'), watch);
	}

	boot();
	document.addEventListener('restart:page', boot);
})();
