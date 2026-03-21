/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors");

module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: {
          500: "#3211d4",
          600: "#2a0fbd",
        },
        background: {
          0: "#f6f6f8",
          50: "#ffffff",
          100: colors.slate[100],
          200: colors.slate[200],
          300: colors.slate[300],
          400: colors.slate[400],
          700: colors.slate[700],
          800: colors.slate[800],
          900: colors.slate[900],
          950: "#131022",
        },
        typography: {
          0: "#ffffff",
          100: colors.slate[100],
          200: colors.slate[200],
          300: colors.slate[300],
          400: colors.slate[400],
          500: colors.slate[500],
          600: colors.slate[600],
          700: colors.slate[700],
          800: colors.slate[800],
          900: colors.slate[900],
        },
        outline: {
          200: colors.slate[200],
          300: colors.slate[300],
          400: colors.slate[400],
          700: colors.slate[700],
          800: colors.slate[800],
        },
        success: colors.emerald,
        info: colors.blue,
        warning: colors.amber,
        error: colors.red,
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
