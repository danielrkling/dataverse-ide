declare module "picomatch" {
  export type PicomatchOptions = {
    dot?: boolean;
    nocase?: boolean;
    nonegate?: boolean;
    bash?: boolean;
    capture?: boolean;
    contains?: boolean;
    ignore?: string | string[];
    literalBrackets?: boolean;
    matchBase?: boolean;
    nobrace?: boolean;
    nodupes?: boolean;
    noext?: boolean;
    noglobstar?: boolean;
    posix?: boolean;
    strictSlashes?: boolean;
    unescape?: boolean;
  };

  export type PicomatchScanResult = {
    input: string;
    base: string;
    glob: string;
    isGlob: boolean;
    isBrace: boolean;
    isBracket: boolean;
    isExtglob: boolean;
    isGlobstar: boolean;
    negated: boolean;
    negatedExtglob: boolean;
  };

  export type PicomatchMatcher = {
    (input: string): boolean;
  };

  export type Picomatch = {
    (glob: string | string[], options?: PicomatchOptions): PicomatchMatcher;
    scan(pattern: string, options?: PicomatchOptions): PicomatchScanResult;
  };

  const picomatch: Picomatch;

  export = picomatch;
}
