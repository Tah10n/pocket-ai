/** @type {import('tailwindcss').Config} */
const themeContract = require("./src/utils/theme-contract.json");

const semanticColors = themeContract.colors;

module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: semanticColors.primary,
        background: {
          ...semanticColors.background,
          muted: semanticColors.background[100],
          error: semanticColors.error[50],
          warning: semanticColors.warning[50],
          success: semanticColors.success[50],
          info: semanticColors.info[50],
        },
        typography: semanticColors.typography,
        outline: semanticColors.outline,
        success: semanticColors.success,
        info: semanticColors.info,
        warning: semanticColors.warning,
        error: semanticColors.error,
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      fontSize: {
        "2xs": ["10px", "14px"],
      },
      maxWidth: {
        "4/5": "80%",
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px",
      },
    },
  },
  plugins: [],
};
