import { useState } from "react";

const demoUser = {
  name: "Demo User",
  email: "demo@example.com",
  password: "demo123",
};

const dashboardData = [
  { id: 1, title: "Monthly Active Users", value: "3,420" },
  { id: 2, title: "New Signups", value: "128" },
  { id: 3, title: "Pending Tasks", value: "5" },
];

function App() {
  const [view, setView] = useState("login");
  const [users, setUsers] = useState([demoUser]);
  const [currentUser, setCurrentUser] = useState(null);
  const [error, setError] = useState("");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

  const handleLoginChange = (event) => {
    setLoginForm({ ...loginForm, [event.target.name]: event.target.value });
  };

  const handleRegisterChange = (event) => {
    setRegisterForm({
      ...registerForm,
      [event.target.name]: event.target.value,
    });
  };

  const login = (event) => {
    event.preventDefault();
    setError("");

    if (!loginForm.email || !loginForm.password) {
      setError("Please enter both email and password.");
      return;
    }

    const foundUser = users.find(
      (user) =>
        user.email === loginForm.email && user.password === loginForm.password,
    );

    if (!foundUser) {
      setError(
        "Invalid email or password. Use demo@example.com / demo123 for demo login.",
      );
      return;
    }

    setCurrentUser(foundUser);
    setView("dashboard");
  };

  const register = (event) => {
    event.preventDefault();
    setError("");

    if (
      !registerForm.name ||
      !registerForm.email ||
      !registerForm.password ||
      !registerForm.confirmPassword
    ) {
      setError("Please complete all registration fields.");
      return;
    }

    if (!registerForm.email.includes("@")) {
      setError("Please use a valid email address.");
      return;
    }

    if (registerForm.password !== registerForm.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (users.some((user) => user.email === registerForm.email)) {
      setError("This email is already registered.");
      return;
    }

    const newUser = {
      name: registerForm.name,
      email: registerForm.email,
      password: registerForm.password,
    };

    setUsers([...users, newUser]);
    setCurrentUser(newUser);
    setRegisterForm({ name: "", email: "", password: "", confirmPassword: "" });
    setView("dashboard");
  };

  const logout = () => {
    setCurrentUser(null);
    setLoginForm({ email: "", password: "" });
    setView("login");
    setError("");
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Micro1 Workflow Portal</h1>
        <p>Demo login / registration only — no backend required.</p>
      </header>

      <main>
        {view === "login" && (
          <section className="card">
            <h2>Login</h2>
            <form onSubmit={login}>
              <label>
                Email
                <input
                  type="email"
                  name="email"
                  value={loginForm.email}
                  onChange={handleLoginChange}
                  placeholder="demo@example.com"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  value={loginForm.password}
                  onChange={handleLoginChange}
                  placeholder="demo123"
                />
              </label>
              {error && <p className="error">{error}</p>}
             
            </form>
            <p className="switch-text">
              Don&apos;t have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setView("register");
                  setError("");
                }}
              >
                Register
              </button>
            </p>
          </section>
        )}

        {view === "register" && (
          <section className="card">
            <h2>Register</h2>
            <form onSubmit={register}>
              <label>
                Name
                <input
                  type="text"
                  name="name"
                  value={registerForm.name}
                  onChange={handleRegisterChange}
                  placeholder="Your name"
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  name="email"
                  value={registerForm.email}
                  onChange={handleRegisterChange}
                  placeholder="you@example.com"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  value={registerForm.password}
                  onChange={handleRegisterChange}
                />
              </label>
              <label>
                Confirm Password
                <input
                  type="password"
                  name="confirmPassword"
                  value={registerForm.confirmPassword}
                  onChange={handleRegisterChange}
                />
              </label>
              {error && <p className="error">{error}</p>}
              <button type="submit">Register</button>
            </form>
            <p className="switch-text">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setView("login");
                  setError("");
                }}
              >
                Login
              </button>
            </p>
          </section>
        )}

        {view === "dashboard" && currentUser && (
          <section className="dashboard">
            <div className="dashboard-header">
              <div>
                <h2>Welcome, {currentUser.name}!</h2>
                <p>This is your demo dashboard with sample analytics data.</p>
              </div>
              <button className="logout-button" type="button" onClick={logout}>
                Logout
              </button>
            </div>
            <div className="data-grid">
              {dashboardData.map((item) => (
                <div key={item.id} className="data-card">
                  <p>{item.title}</p>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>Demo credentials: demo@example.com / demo123</p>
      </footer>
    </div>
  );
}

export default App;
