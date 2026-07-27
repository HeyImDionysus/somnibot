import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Discord-native dark theme.
        //
        // The four bg tiers are Discord's own elevation ladder and must stay in
        // this order, darkest to lightest: tertiary (app shell) < secondary
        // (sidebar) < primary (content) < elevated (cards sitting ON content).
        //
        // `bg-elevated` was the missing rung. Without it, cards were painted in
        // `bg-secondary` — the SAME grey as the sidebar — so a card on a content
        // pane had no contrast against anything and the whole UI read as one flat
        // sheet. That single gap is most of why the dashboard looked a decade old.
        discord: {
          'bg-primary': '#313338',
          'bg-secondary': '#2b2d31',
          'bg-tertiary': '#1e1f22',
          'bg-floating': '#111214',
          'bg-elevated': '#383a40',
          // Interaction states for rows and nav items. Discord uses a distinct
          // grey for hover vs selected; reusing one grey for both loses the
          // "where am I" signal in a 30-item sidebar.
          'bg-hover': '#35373c',
          'bg-active': '#404249',
          'text-primary': '#f2f3f5',
          'text-secondary': '#b5bac1',
          'text-muted': '#949ba4',
          'accent': '#5865f2',
          'accent-hover': '#4752c4',
          'success': '#23a559',
          'danger': '#f23f43',
          'warning': '#f0b232',
          'border-subtle': '#3f4147',
          'border-strong': '#4e5058',
        },
        // SomniBot brand accents. Deliberately NOT the interactive colour —
        // blurple carries every button, link and active state, because that is
        // what makes the product read as Discord. Pink is the brand MARK only
        // (logo, avatar ring), per the owner: "you gotta have the blurple, or
        // its not discord."
        somni: {
          pink: '#FF1493',
          cyan: '#00D4FF',
          orange: '#FF6B00',
        },
      },
      // Discord's current radii. The old 8px/4px pair is the single most dating
      // detail in the UI — modern Discord panels are 12px+ and controls are 8px.
      borderRadius: {
        'card': '12px',
        'input': '8px',
        'panel': '16px',
      },
      transitionDuration: {
        'standard': '150ms',
      },
    },
  },
  plugins: [],
};

export default config;
