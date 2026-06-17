// 自适应悬浮菜单：大屏直接返回顶部，小屏展开子菜单
(function() {
    const menu = document.getElementById('floating-menu');
    const trigger = menu.querySelector('.menu-trigger');
    const btnToc = document.getElementById('btn-show-toc');
    const overlay = document.getElementById('mobile-toc-overlay');
    const closeBtn = overlay ? overlay.querySelector('.mobile-toc-close') : null;
    const backToTop = menu.querySelector('a[href="#top"]');

    if (!menu || !trigger) return;

    // 判断是否为大屏（>768px）
    function isLargeScreen() {
        return window.innerWidth > 768;
    }

    // 主按钮点击处理
    trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        if (isLargeScreen()) {
            // 大屏：直接平滑滚动到顶部
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            // 小屏：展开/收起菜单
            menu.classList.toggle('active');
        }
    });

    // 小屏下点击页面其他地方关闭菜单
    document.addEventListener('click', function(e) {
        if (!isLargeScreen() && !menu.contains(e.target)) {
            menu.classList.remove('active');
        }
    });

    // 小屏下返回顶部子按钮：点击后收起菜单并滚动
    if (backToTop) {
        backToTop.addEventListener('click', function(e) {
            if (!isLargeScreen()) {
                menu.classList.remove('active');
            }
            // 大屏下该链接正常情况下不会显示，此处做兼容
        });
    }

    // 小屏目录按钮：打开面板并收起菜单
    if (btnToc && overlay) {
        btnToc.addEventListener('click', function(e) {
            e.stopPropagation();
            overlay.classList.add('active');
            menu.classList.remove('active');
        });
    }

    // 关闭目录面板
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            overlay.classList.remove('active');
        });
    }
    if (overlay) {
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                overlay.classList.remove('active');
            }
        });
    }

    // 点击目录内链接后自动关闭面板
    if (overlay) {
        const links = overlay.querySelectorAll('.toc-content a');
        links.forEach(link => {
            link.addEventListener('click', function() {
                setTimeout(() => overlay.classList.remove('active'), 150);
            });
        });
    }

    // 窗口大小变化时，如果切换到大屏则自动关闭菜单（避免残留 active）
    window.addEventListener('resize', function() {
        if (isLargeScreen()) {
            menu.classList.remove('active');
        }
    });
})();