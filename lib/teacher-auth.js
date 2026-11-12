// Teacher sign-in through Supabase Auth (email + password). The access token
// is held in page memory only; every teacher API call re-verifies it.
import { createClient } from "@supabase/supabase-js";

export function createTeacherAuth(url, anonKey) {
  const client = () =>
    createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  return {
    async signIn(email, password) {
      const { data, error } = await client().auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data?.session) return null;
      return {
        token: data.session.access_token,
        expiresIn: data.session.expires_in,
        email: data.user.email,
      };
    },
    async verify(token) {
      if (!token) return null;
      const { data, error } = await client().auth.getUser(token);
      if (error || !data?.user?.email) return null;
      return { email: data.user.email.toLowerCase() };
    },
  };
}
