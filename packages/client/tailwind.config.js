/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: 'var(--t-base)',
        mantle: 'var(--t-mantle)',
        surface: 'var(--t-surface)',
        text: 'var(--t-text)',
        subtext: 'var(--t-subtext)',
        accent: 'var(--t-accent)',
      },
    },
  },
  plugins: [],
};
