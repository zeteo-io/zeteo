import type userEvent from "@testing-library/user-event";
import { waitFor } from "@testing-library/react";

type User = ReturnType<typeof userEvent.setup>;

// kosmeo's SearchSelect lists its options in a portal, as plain list items.
const optionItems = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".k-search-list-option"));

/** The labels the open search field offers, in order. */
export const optionTexts = () => optionItems().map((li) => li.textContent);

/** Opens a search field and picks the option labelled `option`. */
export const pickOption = async (
  user: User,
  field: HTMLElement,
  option: string
) => {
  await user.click(field);
  const item = await waitFor(() => {
    const found = optionItems().find((li) => li.textContent === option);
    if (!found) throw new Error(`No option "${option}" in ${optionTexts()}`);
    return found;
  });
  await user.click(item);
};
