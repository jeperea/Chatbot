import i18next from 'i18next';
import Backend from 'i18next-fs-backend';
import path from 'path';

i18next
  .use(Backend)
  .init({
    fallbackLng: 'es',
    preload: ['es', 'en'],
    backend: {
      loadPath: path.join(__dirname, '../locales/{{lng}}/translation.json')
    }
  })
  .catch(err => {
    console.error('❌ Error initializing i18next:', err);
  });

export default i18next;
