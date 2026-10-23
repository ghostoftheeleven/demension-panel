/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eefdf4',
          100: '#d7fae5',
          400: '#34d380',
          500: '#10b973',
          600: '#05965a',
        },
      },
    },
  },
  plugins: [],
}
