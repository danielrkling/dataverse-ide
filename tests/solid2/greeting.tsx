import { createSignal } from "solid-js";

export function Greeting(props: { name: string }) {
  const [shown, setShown] = createSignal(0);
  return (
    <h1 onClick={() => setShown(shown() + 1)}>
      Hello {props.name} (clicked {shown()})
    </h1>
  );
}
