// Resolve the environment at request time: gateway decorators run before
// ConfigModule has loaded the API's .env file.
export const corsOptions = {
  origin: (origin: string | undefined, callback: (error: Error | null, allowed: boolean) => void) => {
    const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:3000';
    callback(null, origin === undefined || origin === webOrigin);
  },
  credentials: true,
};
