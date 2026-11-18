import type userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";

type User = ReturnType<typeof userEvent.setup>;

/**
 * Opens the TableFilters SELECT menu titled `title` and returns it. A closed
 * menu keeps its options in the page, so two menus over the same directory
 * (Owner and Shared with) each need their own scope.
 */
export const openFilterMenu = async (user: User, title = "Who") => {
  const button = await screen.findByRole("button", {
    name: new RegExp(`^${title}`),
  });
  await user.click(button);
  return within(button.closest<HTMLElement>(".k-dropdown-container")!);
};

/** Opens a TableFilters SELECT menu (Who by default) and toggles the option labelled `option`. */
export const toggleFilterOption = async (
  user: User,
  option: string,
  title = "Who"
) => {
  const menu = await openFilterMenu(user, title);
  await user.click(await menu.findByRole("checkbox", { name: option }));
};

/** Whether the option labelled `option` is chosen in the menu; opens it, then closes it. */
export const filterOptionChecked = async (
  user: User,
  option: string,
  title = "Who"
) => {
  const menu = await openFilterMenu(user, title);
  const box = (await menu.findByRole("checkbox", {
    name: option,
  })) as HTMLInputElement;
  const checked = box.checked;
  await user.keyboard("{Escape}");
  return checked;
};
