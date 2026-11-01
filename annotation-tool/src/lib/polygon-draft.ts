import type { PolygonNode } from '../types/index';

/** Kết quả của undo/redo trên bản nháp: `draft` đã xử lý một điểm, `blocked` tiêu thụ phím nhưng không đổi gì, `global` chuyển sang lịch sử chung. */
export type DraftStep = 'draft' | 'blocked' | 'global';

/**
 * Lịch sử cục bộ khi đang chấm điểm một polygon mới (công cụ P). Mỗi lần chấm/xóa điểm đẩy danh sách
 * điểm trước đó vào `undo`, nên Ctrl+Z gỡ đúng **một điểm vừa chấm**, Ctrl+Y/Ctrl+Shift+Z chấm lại.
 * Khi đã gỡ hết điểm, undo tiếp theo rời bản nháp và chuyển sang lịch sử chung của mask (hoàn tác cả
 * polygon đã hoàn tất trước đó). Hợp đồng này được người dùng nhấn mạnh (2026-10-25) và khóa bằng
 * `polygon-draft.test.ts` + kịch bản trình duyệt `canvas-browser-check`.
 *
 * `nodes` luôn được thay bằng mảng mới khi đổi, để chỗ gọi so sánh tham chiếu (ví dụ hoàn tất polygon
 * sau khi vector hóa xong chỉ áp dụng nếu bản nháp chưa đổi).
 */
export class PolygonDraft {
  nodes: PolygonNode[] = [];
  /** Đang chấm một polygon mới; vẫn true sau khi gỡ hết điểm cho tới undo kế tiếp. */
  editing = false;
  private undoStack: PolygonNode[][] = [];
  private redoStack: PolygonNode[][] = [];

  /** Chấm thêm một điểm. */
  add(node: PolygonNode) {
    this.editing = true;
    this.undoStack.push(this.nodes);
    this.redoStack = [];
    this.nodes = [...this.nodes, node];
  }

  /** Xóa một điểm theo id (chuột phải lên điểm); có thể hoàn tác. Trả về false nếu không có điểm đó. */
  remove(nodeId: string): boolean {
    if (!this.nodes.some((node) => node.id === nodeId)) return false;
    this.undoStack.push(this.nodes);
    this.redoStack = [];
    this.nodes = this.nodes.filter((node) => node.id !== nodeId);
    return true;
  }

  undo(): DraftStep {
    if (!this.editing) return 'global';
    const previous = this.undoStack.pop();
    if (previous) {
      this.redoStack.push(this.nodes);
      this.nodes = previous;
      return 'draft';
    }
    if (this.nodes.length) return 'blocked';
    // Đã gỡ hết điểm: rời bản nháp, các phím tiếp theo dùng lịch sử chung.
    this.editing = false;
    this.redoStack = [];
    return 'global';
  }

  redo(): DraftStep {
    if (!this.editing) return 'global';
    const next = this.redoStack.pop();
    if (next) {
      this.undoStack.push(this.nodes);
      this.nodes = next;
      return 'draft';
    }
    return this.nodes.length ? 'blocked' : 'global';
  }

  /**
   * Double-click: hai lần pointer-down đã chấm cùng một đỉnh hai lần. Giữ lần nhấp đầu làm đỉnh cuối,
   * bỏ bản sao (không đưa vào redo) trước khi hoàn tất.
   */
  dropDoubleClickDuplicate() {
    if (this.nodes.length > 1) this.nodes = this.undoStack.pop() ?? this.nodes.slice(0, -1);
  }

  clear() {
    this.nodes = [];
    this.editing = false;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Trạng thái nút Hoàn tác/Làm lại: `local` khi undo/redo đang áp dụng cho từng điểm của bản nháp. */
  historyState(globalUndo: number, globalRedo: number) {
    const local = this.editing && this.nodes.length > 0;
    return {
      local,
      canUndo: local ? this.undoStack.length > 0 : globalUndo > 0,
      canRedo: (this.editing && this.redoStack.length > 0) || (!local && globalRedo > 0),
    };
  }
}
