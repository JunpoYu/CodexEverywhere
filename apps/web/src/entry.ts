import "./style.css";

if (location.pathname === "/admin" || location.pathname.startsWith("/admin/")) {
  void import("./admin-main.js");
} else {
  void import("./main.js");
}
