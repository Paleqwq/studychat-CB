export type BrowserIdentity = "participant" | "english-participant" | "admin";

export type BrowserSession = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  user?: { id: string; is_anonymous?: boolean; email?: string };
};

export type BrowserAuthEvent = "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED" | string;
export type BrowserAuthResult = { data: { session: BrowserSession | null }; error: unknown | null };

// Both providers expose this small contract; database access remains on the server.
export type BrowserAuthClient = {
  auth: {
    getSession(): Promise<BrowserAuthResult>;
    signInAnonymously(options?: { options?: { captchaToken?: string } }): Promise<BrowserAuthResult>;
    signInWithPassword(credentials: { email: string; password: string }): Promise<BrowserAuthResult>;
    signOut(): Promise<{ error: unknown | null }>;
    onAuthStateChange(callback: (event: BrowserAuthEvent, session: BrowserSession | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
};
