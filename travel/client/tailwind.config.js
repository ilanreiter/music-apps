import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "oklch(97% 0.020 205)",
          100: "oklch(94% 0.040 205)",
          200: "oklch(88% 0.070 205)",
          300: "oklch(80% 0.100 205)",
          400: "oklch(70% 0.130 205)",
          500: "oklch(60% 0.140 205)",
          600: "oklch(50% 0.130 205)",
          700: "oklch(42% 0.110 205)",
          800: "oklch(34% 0.090 205)",
          900: "oklch(27% 0.070 205)",
        },
      },
      fontFamily: {
        display: ["'Space Grotesk'", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [typography],
};
