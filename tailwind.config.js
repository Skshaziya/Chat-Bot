// tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    // CRITICAL: Must include your source directory
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}", 
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}