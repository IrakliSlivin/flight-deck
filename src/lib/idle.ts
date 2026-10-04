// Marks <html data-idle> while the window is unfocused or hidden, so index.css can
// pause the endless CSS animations. WebKitGTK keeps animating (and Skia keeps
// repainting) a window that is merely covered, which kept the web process near
// 100% CPU all day.
function sync() {
  const idle = document.hidden || !document.hasFocus();
  document.documentElement.toggleAttribute("data-idle", idle);
}

window.addEventListener("focus", sync);
// Focus moving into an iframe (Ops Atlas) blurs the window but the document keeps focus.
window.addEventListener("blur", () => setTimeout(sync, 0));
document.addEventListener("visibilitychange", sync);
sync();
