import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Apply class synchronously on first JS execution so there's no light-mode
// flash before React mounts.
function applyThemeClass(theme: Theme) {
  if (typeof window === "undefined") return;
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = theme === "dark" || (theme === "system" && mediaQuery.matches);
  const root = window.document.documentElement;
  const body = window.document.body;
  root.classList.remove("light", "dark");
  root.classList.add(isDark ? "dark" : "light");
  // Mirror onto <body> so any selector that scopes from body (or 3rd-party
  // CSS that wasn't aware of html-level class) still flips correctly.
  if (body) {
    body.classList.remove("light", "dark");
    body.classList.add(isDark ? "dark" : "light");
    body.style.colorScheme = isDark ? "dark" : "light";
  }
}

// Run once at module load so the very first paint matches the saved theme.
if (typeof window !== "undefined") {
  try {
    const saved = (localStorage.getItem("theme") as Theme) || "system";
    applyThemeClass(saved);
  } catch {
    /* no-op */
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem("theme") as Theme;
    return savedTheme || "system";
  });

  const setTheme = (next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* no-op */
    }
    // Apply immediately so callers see an instant visual change instead of
    // waiting for the next render commit.
    applyThemeClass(next);
  };

  // Synchronous so the DOM class is updated before the browser paints.
  useLayoutEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // Listen for OS-level changes when the user picked "system".
  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyThemeClass("system");
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  const [isDarkMode, setIsDarkMode] = useState(false);
  const { theme, setTheme } = context;

  // Determine if dark mode is active when component mounts or theme changes
  useEffect(() => {
    const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => {
      setIsDarkMode(
        theme === "dark" || (theme === "system" && darkModeQuery.matches),
      );
    };

    updateTheme();
    darkModeQuery.addEventListener("change", updateTheme);

    return () => {
      darkModeQuery.removeEventListener("change", updateTheme);
    };
  }, [theme]);
  return { theme, isDarkMode, setTheme };
}
