import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Discord-native dark theme
        discord: {
          'bg-primary': '#313338',
          'bg-secondary': '#2b2d31',
          'bg-tertiary': '#1e1f22',
          'bg-floating': '#111214',
          'text-primary': '#f2f3f5',
          'text-secondary': '#b5bac1',
          'text-muted': '#949ba4',
          'accent': '#5865f2',
          'success': '#23a559',
          'danger': '#f23f43',
          'warning': '#f0b232',
          'border-subtle': '#3f4147',
          'border-strong': '#4e5058',
        },
        // SomniBot brand accents (used sparingly)
        somni: {
          pink: '#FF1493',
          cyan: '#00D4FF',
          orange: '#FF6B00',
        },
      },
      borderRadius: {
        'card': '8px',
        'input': '4px',
      },
      transitionDuration: {
        'standard': '150ms',
      },
    },
  },
  plugins: [],
};

export default config;
