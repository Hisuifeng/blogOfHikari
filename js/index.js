var page_welcome = document.getElementById("page-welcome");
var background = document.getElementById("background-overlay");
background.classList.remove("background-overlay")
var page = document.getElementById("page");
page_welcome.addEventListener("wheel", function (event) {
    var deltaY = event.deltaY;
    if (deltaY > 0) {
        welcomeFunc();
    }
});
function welcomeFunc(){
    page_welcome.style.display = "none";
        page.style.display = "grid";
        page.classList.add('animate-up');
        background.classList.add('animate-opacity');
        background.classList.add("background-overlay")
};