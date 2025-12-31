import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "My Awesome Project",
  description: "A VitePress Site",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Java', link: '/Java' },
      { text: 'Examples', link: '/markdown-examples' }
    ],

    sidebar: {
      // 当用户位于 `guide` 目录时，会显示此侧边栏
      '/Java/': [
        {
          text: 'Java',
          items: [
            { text: '经典问题', link: '/Java/经典问题' },
            { text: '面试', items: [
                { text: '经典问题', link: '/Java/经典问题' }
              ]
            }
          ]
        }
      ],

      // 当用户位于 `config` 目录时，会显示此侧边栏
      '/markdown-examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Markdown Examples', link: '/markdown-examples' },
            { text: 'Runtime API Examples', link: '/api-examples' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/vuejs/vitepress' }
    ]
  }
})