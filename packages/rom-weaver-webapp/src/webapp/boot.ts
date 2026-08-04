import "./design-system/index.css";

const loadMain = () => {
  setTimeout(() => {
    void import("./main.tsx");
  }, 0);
};

if (typeof requestAnimationFrame === "function") requestAnimationFrame(loadMain);
else loadMain();
