/**
 * Configuracion PUBLICA de la aplicacion, versionada a proposito.
 *
 * Es un modulo JavaScript normal (no JSON) para que cualquier empaquetador
 * -incluido el de Netlify- lo incluya sin depender de import attributes.
 *
 * Aqui NO va nunca una clave secreta: ni service_role, ni el secreto JWT, ni la
 * cadena de conexion a la base de datos. Esas van en variables de entorno.
 * Cualquier valor de este fichero puede sobreescribirse con su variable de
 * entorno equivalente.
 */
export const publicConfig = {
  // 'none'     -> el dashboard es accesible sin iniciar sesion
  // 'local'    -> un unico administrador (ADMIN_USERNAME / ADMIN_PASSWORD_HASH)
  // 'supabase' -> usuarios reales gestionados por Supabase Auth
  authProvider: 'none',

  supabase: {
    url: 'https://txawmfomjaqmehwqvufq.supabase.co',
    anonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4YXdtZm9tamFxbWVod3F2dWZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0ODQ1NTMsImV4cCI6MjEwNTA2MDU1M30.6qT4zu4DnQxoAJyNw-FQxQk1YEsZUVTr9zdfM-XEdiU',
  },
};

export default publicConfig;
