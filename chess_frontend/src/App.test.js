import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

test("renders the chess app title", () => {
  render(<App />);
  expect(screen.getByText(/retro chess/i)).toBeInTheDocument();
});

test("draw offer flow surfaces accept/decline banner", async () => {
  const user = userEvent.setup();
  render(<App />);

  const offerBtn = screen.getByRole("button", { name: /offer draw/i });
  expect(offerBtn).toBeInTheDocument();
  expect(offerBtn).toBeEnabled();

  await user.click(offerBtn);

  // After offering a draw, the opponent (black) is to move, and a banner should show.
  expect(await screen.findByRole("button", { name: /accept/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument();
});
