export type DesktopWindowFitRequest = {
  generation: number;
  viewportWidth: number;
  contentHeight: number;
};

export class DesktopWindowFitCoordinator {
  private generation = 0;

  beginLayoutChange() {
    this.generation += 1;
    return this.generation;
  }

  capture(
    generation: number,
    viewportWidth: number,
    contentHeight: number,
  ): DesktopWindowFitRequest | null {
    if (generation !== this.generation) return null;
    return { generation, viewportWidth, contentHeight };
  }

  isCurrent(request: DesktopWindowFitRequest, viewportWidth: number) {
    return (
      request.generation === this.generation &&
      request.viewportWidth === viewportWidth
    );
  }
}
