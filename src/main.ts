import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { DefaultApolloClient } from '@vue/apollo-composable'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import App from './App.vue'
import router from './router'
import { apolloClient } from './api/apollo'
import './styles.css'

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: 'fireControl',
    themes: {
      fireControl: {
        dark: false,
        colors: {
          primary: '#A33A2A',
          secondary: '#265E66',
          surface: '#FFFFFF',
          background: '#F2F3F1',
          error: '#C53B2A',
          warning: '#D28A2D',
          success: '#39785F',
        },
      },
    },
  },
})

createApp(App)
  .provide(DefaultApolloClient, apolloClient)
  .use(createPinia())
  .use(router)
  .use(vuetify)
  .mount('#app')
