/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      transitionProperty: {
        radius: 'border-radius',
      },

      fontSize: {
        xxs: '0.75rem', // 0.625rem * 1.2
        tiny: '0.6rem', // 0.5rem * 1.2
        xs: '0.75rem', // 0.75rem * 1.2
        sm: '0.875rem', // 0.875rem * 1.2
        base: '1.2rem', // 1rem * 1.2
        lg: '1.5rem', // 1.125rem * 1.2
        xl: '1.875rem', // 1.25rem * 1.2
        '2xl': '2.25rem', // 1.5rem * 1.2
        '3xl': '2.25rem', // 1.875rem * 1.2
        '4xl': '3rem', // 2.25rem * 1.2
        '5xl': '3.75rem', // 3rem * 1.2
        '6xl': '4.5rem', // 3.75rem * 1.2
        '7xl': '6rem', // 4.5rem * 1.2
        '8xl': '8rem', // 6rem * 1.2
        '9xl': '9rem', // 8rem * 1.2
      },

      typography: () => ({
        DEFAULT: {
          css: {
            p: {
              '@apply text-base': {},
            },
            li: {
              '@apply text-base': {},
            },
            hr: {
              '@apply mt-6 mb-6 max-w-[95%] mx-auto': {},
            },
            'h1, h2, h3, h4, h5, h6': {
              '@apply mt-0': {},
            },
          },
        },
      }),
    },
  },
};
