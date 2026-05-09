/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: {
          main: '#0B0F17',
          panel: '#111827',
          'panel-soft': '#0F172A',
        },
        text: {
          primary: '#E5E7EB',
          secondary: '#9CA3AF',
          muted: '#6B7280',
        },
        border: {
          DEFAULT: 'rgba(255, 255, 255, 0.06)',
        },
        'accent-indigo': '#6366F1',
        'accent-purple': '#8B5CF6',
        'accent-blue': '#3B82F6',
        'accent-green': '#22C55E',
        'accent-red': '#EF4444',
        'accent-yellow': '#F59E0B',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
