interface SignInPageProps {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const failed = params.error === "1";

  return (
    <main>
      <h1>Sign in to PolicyOffice</h1>
      <form action="/session" method="post">
        <label htmlFor="contactEmail">Email</label>
        <input
          autoComplete="username"
          id="contactEmail"
          name="contactEmail"
          required
          type="email"
        />
        <label htmlFor="password">Password</label>
        <input
          autoComplete="current-password"
          id="password"
          name="password"
          required
          type="password"
        />
        <button type="submit">Sign in</button>
      </form>
      <p aria-live="polite" role="alert">
        {failed ? "Email or password was not recognised." : ""}
      </p>
    </main>
  );
}
