import { createSignal, For } from "solid-js";
import { render } from "@solidjs/web";
import { Greeting } from "./greeting.tsx";

export function App() {
  const [count, setCount] = createSignal(0);
  return (
    <div class="app" onClick={() => setCount(count() + 1)}>
      <Greeting name="world" />
      <For each={["a", "b"]}>{(item) => <p>{item}</p>}</For>
      <button disabled={count() > 3}>Count: {count()}</button>
    </div>
  );
}

render(() => <App />, document.getElementById("root"));
