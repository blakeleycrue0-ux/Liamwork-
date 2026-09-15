/**
 * Runs the boot sequence and turns a configuration problem into a readable
 * message instead of a stack trace - the first thing you see on a bad deploy.
 */
export function startOrExit(bootstrap) {
  try {
    return bootstrap();
  } catch (error) {
    console.error(`\n${error.message}\n`);
    console.error('Revisa el fichero .env (ver .env.example) y vuelve a arrancar.');
    return process.exit(1);
  }
}
