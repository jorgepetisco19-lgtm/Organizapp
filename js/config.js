// Datos públicos del proyecto de Supabase de Organizapp.
// La clave "publishable" está pensada para ir en la web: lo que protege los datos
// son las reglas de acceso de la base de datos (sql/01_estructura.sql), no esconder esta clave.
// NUNCA pongas aquí la clave "secret" ni la "service_role".
export const SUPABASE_URL = 'https://qyvipsdbytpcedlovotk.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_UgsWDi8pTlo_X59UjeAkKA_BijS4Xav';

// ---- Solo para la app de Android (APK) ----
// Dirección pública de la web (la app de Android no vive en ella, pero la usa para compartir el enlace y saber si hay versión nueva).
export const URL_APP = 'https://jorgepetisco19-lgtm.github.io/Organizapp/';
// Donde se descarga la última APK.
export const URL_DESCARGA = 'https://github.com/jorgepetisco19-lgtm/Organizapp/releases/latest';
// A dónde vuelve el navegador tras entrar con Google. Debe estar añadida en Supabase → Authentication → URL Configuration → Redirect URLs.
export const REDIRECT_NATIVO = 'io.github.jorgepetisco19lgtm.organizapp://auth';
