// Showcase sample — real path: lib/repositories/escalation_repository.dart.
// Data-access layer behind the escalation timeline shown on Invoice Detail.
import 'package:supabase_flutter/supabase_flutter.dart';
import '../models/escalation_pause.dart';
import '../models/escalation_stage.dart';
import '../models/invoice_link_click.dart';

class EscalationRepository {
  final SupabaseClient client;

  EscalationRepository({required this.client});

  Future<List<EscalationStage>> listStages(String invoiceId) async {
    final rows = await client
        .from('escalation_stages')
        .select()
        .eq('invoice_id', invoiceId);
    final stages = rows.map((row) => EscalationStage.fromJson(row)).toList();
    stages.sort((a, b) => a.stageNumber.compareTo(b.stageNumber));
    return stages;
  }

  Future<List<EscalationPause>> listPauses(String invoiceId) async {
    final rows = await client
        .from('escalation_pauses')
        .select()
        .eq('invoice_id', invoiceId);
    final pauses = rows.map((row) => EscalationPause.fromJson(row)).toList();
    pauses.sort((a, b) => a.pausedAt.compareTo(b.pausedAt));
    return pauses;
  }

  Future<void> pause(String invoiceId) async {
    await client.rpc('pause_invoice', params: {'p_invoice_id': invoiceId});
  }

  Future<void> resume(String invoiceId) async {
    await client.rpc('resume_invoice', params: {'p_invoice_id': invoiceId});
  }

  Future<List<InvoiceLinkClick>> listClicks(String invoiceId) async {
    final rows = await client
        .from('invoice_link_clicks')
        .select()
        .eq('invoice_id', invoiceId);
    final clicks = rows.map((row) => InvoiceLinkClick.fromJson(row)).toList();
    clicks.sort((a, b) => b.clickedAt.compareTo(a.clickedAt)); // newest first
    return clicks;
  }

  /// Whether this invoice is part of an unresolved (not yet fully paused/paid)
  /// stop request's snapshot -- drives the invoice-detail screen's
  /// "auto-pause backstop pending" indicator (spec 6.5).
  Future<bool> hasUnresolvedStopRequest(String invoiceId) async {
    final links = await client
        .from('stop_request_invoices')
        .select('stop_request_id')
        .eq('invoice_id', invoiceId);
    if (links.isEmpty) return false;

    final stopRequestIds =
        links.map((row) => row['stop_request_id'] as String).toList();
    final unresolved = await client
        .from('stop_requests')
        .select('id')
        .inFilter('id', stopRequestIds)
        .isFilter('handled_at', null);
    return unresolved.isNotEmpty;
  }
}
